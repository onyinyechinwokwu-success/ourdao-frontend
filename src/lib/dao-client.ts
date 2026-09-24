'use client'

/**
 * Soroban client for the OurDAO contract.
 *
 * `read` simulates a contract call and decodes the result (no wallet needed).
 * `invoke` prepares, signs (via Freighter), submits, and polls a state-changing
 * call. Typed wrappers below mirror the Rust contract's public interface.
 */
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import {
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  isContractConfigured,
  server,
} from './stellar'
import { formatContractError } from './contract-errors'

// Multiplier for inclusion fee to survive network congestion.
// The inclusion fee (stroops/byte) is what validators use to order transactions
// when the ledger is full. BASE_FEE (100 stroops) is the protocol floor, not a
// recommended value. This multiplier ensures submissions carry headroom above the
// floor, preventing silent drops when competing with higher-fee transactions.
// Note: This is distinct from Soroban's resource fee, which prepareTransaction
// computes separately and adds on top of this inclusion fee.
const INCLUSION_FEE_MULTIPLIER = 1.5
// TransactionBuilder takes the fee as a string of stroops, and BASE_FEE is
// itself a string, so it must be coerced before the multiplication.
const INCLUSION_FEE = String(Math.ceil(Number(BASE_FEE) * INCLUSION_FEE_MULTIPLIER))

// ---------------------------------------------------------------------------
// ScVal argument builders (JS value -> Soroban value with the right type)
// ---------------------------------------------------------------------------

export const sc = {
  addr: (a: string): xdr.ScVal => new Address(a).toScVal(),
  i128: (v: bigint | number | string): xdr.ScVal =>
    nativeToScVal(BigInt(v), { type: 'i128' }),
  u32: (v: number): xdr.ScVal => nativeToScVal(v, { type: 'u32' }),
  u64: (v: bigint | number): xdr.ScVal =>
    nativeToScVal(BigInt(v), { type: 'u64' }),
  // Booleans map unambiguously to scvBool; nativeToScVal needs no type hint
  // (there's no 'bool' entry in its ScValType union at all).
  bool: (v: boolean): xdr.ScVal => nativeToScVal(v),
  str: (v: string): xdr.ScVal => nativeToScVal(v, { type: 'string' }),
  bytes: (v: Uint8Array): xdr.ScVal => xdr.ScVal.scvBytes(v as Buffer),
  vecAddr: (list: string[]): xdr.ScVal =>
    xdr.ScVal.scvVec(list.map((a) => new Address(a).toScVal())),
  // ProposalKind is a unit-variant enum: encoded as a single-symbol vector.
  proposalKind: (kind: 'Loan' | 'Treasury'): xdr.ScVal =>
    xdr.ScVal.scvVec([xdr.ScVal.scvSymbol(kind)]),
}

export interface LoanPolicyInput {
  minMembershipDuration: number | bigint
  membershipContribution: bigint | number | string
  maxLoanDuration: number | bigint
  minInterestRate: number
  maxInterestRate: number
  cooldownPeriod: number | bigint
  maxLoanToTreasuryRatio: number
  defaultGracePeriod: number | bigint
  defaultPenaltyBps: number
}

export function policyToScVal(p: LoanPolicyInput): xdr.ScVal {
  return nativeToScVal(
    {
      min_membership_duration: BigInt(p.minMembershipDuration),
      membership_contribution: BigInt(p.membershipContribution),
      max_loan_duration: BigInt(p.maxLoanDuration),
      min_interest_rate: p.minInterestRate,
      max_interest_rate: p.maxInterestRate,
      cooldown_period: BigInt(p.cooldownPeriod),
      max_loan_to_treasury_ratio: p.maxLoanToTreasuryRatio,
      default_grace_period: BigInt(p.defaultGracePeriod),
      default_penalty_bps: p.defaultPenaltyBps,
    },
    {
      type: {
        min_membership_duration: ['symbol', 'u64'],
        membership_contribution: ['symbol', 'i128'],
        max_loan_duration: ['symbol', 'u64'],
        min_interest_rate: ['symbol', 'u32'],
        max_interest_rate: ['symbol', 'u32'],
        cooldown_period: ['symbol', 'u64'],
        max_loan_to_treasury_ratio: ['symbol', 'u32'],
        default_grace_period: ['symbol', 'u64'],
        default_penalty_bps: ['symbol', 'u32'],
      },
    }
  )
}

// ---------------------------------------------------------------------------
// Core read / invoke
// ---------------------------------------------------------------------------

/** Simulate a read-only call and decode the return value. Returns null when no
 * contract is configured or the call yields no value. */
export async function read<T = unknown>(
  method: string,
  ...args: xdr.ScVal[]
): Promise<T | null> {
  if (!isContractConfigured()) return null

  const contract = new Contract(CONTRACT_ID)
  // Simulation needs a source account but never touches it on-chain; a throwaway
  // keypair is generated per read even though a fixed placeholder would do.
  const source = new Account(Keypair.random().publicKey(), '0')
  const tx = new TransactionBuilder(source, {
    fee: INCLUSION_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  const sim = await server.simulateTransaction(tx)
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(formatContractError(sim.error))
  }
  const retval = sim.result?.retval
  return retval ? (scValToNative(retval) as T) : null
}

export interface InvokeResult {
  hash: string
  returnValue: unknown
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const POLL_INTERVAL_MS = 1000
/** Fallback poll budget when a signed transaction carries no time bounds
 * (shouldn't happen — `.setTimeout(30)` always sets one — but a hardcoded
 * cap is cheap insurance against polling forever). */
const DEFAULT_POLL_BUDGET_MS = 30_000

/**
 * A submission/confirmation failure from {@link invoke}, distinct from a
 * decoded on-chain contract error.
 *
 * `retryable` is true when resubmitting the exact same signed transaction
 * (or a fresh one, for `TRY_AGAIN_LATER`) has a real chance of succeeding —
 * a transient RPC-node condition rather than something the transaction
 * itself is wrong about — so the UI can offer a "Try again" affordance
 * instead of just surfacing the message (#58).
 */
export class InvokeError extends Error {
  readonly retryable: boolean

  constructor(message: string, opts: { retryable?: boolean } = {}) {
    super(message)
    this.name = 'InvokeError'
    this.retryable = opts.retryable ?? false
  }
}

/** Prepare, sign, submit, and confirm a state-changing call. */
export async function invoke(
  walletAddress: string,
  signXDR: (xdr: string) => Promise<string>,
  method: string,
  ...args: xdr.ScVal[]
): Promise<InvokeResult> {
  if (!isContractConfigured()) {
    throw new Error('No contract configured (set NEXT_PUBLIC_CONTRACT_ID).')
  }

  const contract = new Contract(CONTRACT_ID)
  const account = await server.getAccount(walletAddress)
  const built = new TransactionBuilder(account, {
    fee: INCLUSION_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(30)
    .build()

  // Simulate + assemble auth entries and resource footprint.
  const prepared = await server.prepareTransaction(built)
  const signedXdr = await signXDR(prepared.toXDR())
  const signedTx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE)

  const sent = await server.sendTransaction(signedTx)

  // Every `sendTransaction` status gets an explicit branch (#58) — the old
  // code only checked for 'ERROR' and let PENDING, DUPLICATE, and
  // TRY_AGAIN_LATER all fall through identically into the confirmation
  // poll below, even though TRY_AGAIN_LATER means the node never queued
  // the transaction at all: there is nothing to poll for, and polling
  // anyway just spends 30s finding out NOT_FOUND before reporting the
  // wrong cause.
  switch (sent.status) {
    case 'ERROR':
      throw new InvokeError(formatContractError(JSON.stringify(sent.errorResult)), {
        retryable: false,
      })
    case 'TRY_AGAIN_LATER':
      throw new InvokeError(
        'The network is busy and did not accept this transaction. Please try again in a moment.',
        { retryable: true },
      )
    case 'DUPLICATE':
      // Already queued by an earlier identical submission (e.g. a double
      // click) — poll for the hash that's already in flight rather than
      // treating this as a fresh failure or silently rebuilding/resending.
      break
    case 'PENDING':
      break
    default:
      // Exhaustiveness guard: a status the SDK's type union doesn't (yet)
      // name is safer surfaced as an explicit error than silently falling
      // into the poll below.
      throw new InvokeError(`Unexpected submission status: ${String(sent.status)}`, {
        retryable: false,
      })
  }

  // Poll until the transaction's own time bounds expire rather than a
  // hardcoded iteration count, so the poll budget always matches the
  // window during which the network could actually still include it.
  // FeeBumpTransaction has no timeBounds of its own (only its inner
  // Transaction does), so fall back to the default budget for those.
  const deadlineMs =
    signedTx instanceof Transaction && signedTx.timeBounds?.maxTime
      ? Number(signedTx.timeBounds.maxTime) * 1000
      : Date.now() + DEFAULT_POLL_BUDGET_MS

  let result = await server.getTransaction(sent.hash)
  while (result.status === 'NOT_FOUND' && Date.now() < deadlineMs) {
    await sleep(POLL_INTERVAL_MS)
    result = await server.getTransaction(sent.hash)
  }

  if (result.status === 'NOT_FOUND') {
    // Distinct from a confirmed failure: the transaction's submission
    // window expired before the network confirmed it either way. It may
    // still land — the caller (or a background reconciliation) should
    // check `sent.hash` again later rather than treat this as terminal.
    throw new InvokeError(
      `Transaction ${sent.hash} was not confirmed before its submission window expired. It may still complete — check its status before retrying.`,
      { retryable: true },
    )
  }
  if (result.status !== 'SUCCESS') {
    throw new InvokeError(`Transaction ${sent.hash} failed on-chain (${result.status}).`, {
      retryable: false,
    })
  }
  return {
    hash: sent.hash,
    returnValue: result.returnValue ? scValToNative(result.returnValue) : null,
  }
}

// ---------------------------------------------------------------------------
// Typed read wrappers (mirror the Rust contract views)
// ---------------------------------------------------------------------------

export const daoRead = {
  getTotalMembers: () => read<number>('get_total_members'),
  getActiveMembers: () => read<number>('get_active_members'),
  getConsensusThreshold: () => read<number>('get_consensus_threshold'),
  getTreasuryBalance: () => read<bigint>('get_treasury_balance'),
  getLoanPolicy: () => read<Record<string, unknown>>('get_loan_policy'),
  getToken: () => read<string>('get_token'),
  isPaused: () => read<boolean>('is_paused'),
  getAdmins: () => read<string[]>('get_admins'),
  isMember: (addr: string) => read<boolean>('is_member', sc.addr(addr)),
  isAdmin: (addr: string) => read<boolean>('is_admin', sc.addr(addr)),
  isEligibleForLoan: (addr: string) =>
    read<boolean>('is_eligible_for_loan', sc.addr(addr)),
  getMember: (addr: string) =>
    read<Record<string, unknown> | null>('get_member', sc.addr(addr)),
  getPendingYield: (addr: string) =>
    read<bigint>('get_pending_yield', sc.addr(addr)),
  getStake: (addr: string) => read<bigint>('get_stake', sc.addr(addr)),
  getLoan: (id: number) => read<Record<string, unknown> | null>('get_loan', sc.u32(id)),
  getLoanProposal: (id: number) =>
    read<Record<string, unknown> | null>('get_loan_proposal', sc.u32(id)),
  getTreasuryProposal: (id: number) =>
    read<Record<string, unknown> | null>('get_treasury_proposal', sc.u32(id)),
  calculateLoanTerms: (amount: bigint | number) =>
    read<Record<string, unknown>>('calculate_loan_terms', sc.i128(amount)),
  calculateExitShare: (addr: string) =>
    read<bigint>('calculate_exit_share', sc.addr(addr)),
  resolveName: (name: string) => read<string | null>('resolve_name', sc.str(name)),
  nameOf: (addr: string) => read<string | null>('name_of', sc.addr(addr)),
  getDocument: (kind: 'Loan' | 'Treasury', id: number) =>
    read<Uint8Array | null>('get_document', sc.proposalKind(kind), sc.u32(id)),
  // For a private (commit-reveal) treasury proposal this is true as soon as
  // `voter` has committed, not only once revealed — the contract folds both
  // into one bool since a commitment already blocks a second vote. There is
  // no separate view to tell "committed, not yet revealed" apart from
  // "fully voted".
  hasVoted: (kind: 'Loan' | 'Treasury', proposalId: number, voter: string) =>
    read<boolean>('has_voted', sc.proposalKind(kind), sc.u32(proposalId), sc.addr(voter)),
}

// ---------------------------------------------------------------------------
// Typed write wrappers — bound to a connected wallet + signer
// ---------------------------------------------------------------------------

export function daoWrite(
  address: string,
  signXDR: (xdr: string) => Promise<string>
) {
  const send = (method: string, ...args: xdr.ScVal[]) =>
    invoke(address, signXDR, method, ...args)

  return {
    registerMember: () => send('register_member', sc.addr(address)),
    exitDao: () => send('exit_dao', sc.addr(address)),
    claimRewards: () => send('claim_rewards', sc.addr(address)),

    requestLoan: (amount: bigint | number) =>
      send('request_loan', sc.addr(address), sc.i128(amount)),
    editLoanProposal: (proposalId: number, newAmount: bigint | number) =>
      send('edit_loan_proposal', sc.addr(address), sc.u32(proposalId), sc.i128(newAmount)),
    voteOnLoanProposal: (proposalId: number, support: boolean) =>
      send('vote_on_loan_proposal', sc.addr(address), sc.u32(proposalId), sc.bool(support)),
    repayLoan: (loanId: number) =>
      send('repay_loan', sc.addr(address), sc.u32(loanId)),
    // Partial repayment — amount is applied to accrued interest first, then
    // principal; the interest portion is distributed to active members as
    // yield immediately (see contracts/dao/src/loans.rs). Rejects amount
    // <= 0 or amount > outstanding balance.
    repayLoanPartial: (loanId: number, amount: bigint | number) =>
      send('repay_loan_partial', sc.addr(address), sc.u32(loanId), sc.i128(amount)),
    // Permissionless: the contract takes no caller argument (anyone can
    // trigger this once a loan is overdue past its grace period).
    markLoanDefaulted: (loanId: number) => send('mark_loan_defaulted', sc.u32(loanId)),

    proposeTreasuryWithdrawal: (
      amount: bigint | number,
      destination: string,
      reason: string,
      isPrivate: boolean
    ) =>
      send(
        'propose_treasury_withdrawal',
        sc.addr(address),
        sc.i128(amount),
        sc.addr(destination),
        sc.str(reason),
        sc.bool(isPrivate)
      ),
    voteOnTreasuryProposal: (proposalId: number, support: boolean) =>
      send('vote_on_treasury_proposal', sc.addr(address), sc.u32(proposalId), sc.bool(support)),

    stake: (amount: bigint | number) =>
      send('stake', sc.addr(address), sc.i128(amount)),
    unstake: (amount: bigint | number) =>
      send('unstake', sc.addr(address), sc.i128(amount)),

    registerName: (name: string) =>
      send('register_name', sc.addr(address), sc.str(name)),

    commitTreasuryVote: (proposalId: number, commitment: Uint8Array) =>
      send('commit_treasury_vote', sc.addr(address), sc.u32(proposalId), sc.bytes(commitment)),
    revealTreasuryVote: (proposalId: number, support: boolean, salt: Uint8Array) =>
      send(
        'reveal_treasury_vote',
        sc.addr(address),
        sc.u32(proposalId),
        sc.bool(support),
        sc.bytes(salt)
      ),

    attachDocument: (kind: 'Loan' | 'Treasury', proposalId: number, contentHash: Uint8Array) =>
      send('attach_document', sc.addr(address), sc.proposalKind(kind), sc.u32(proposalId), sc.bytes(contentHash)),

    // Admin-only entrypoints. The contract itself enforces the admin check
    // (`util::require_admin`) — `address` here is the connected wallet acting
    // as `caller`, not necessarily an admin; a non-admin call simply fails
    // on-chain with NotAdmin.
    addAdmin: (admin: string) => send('add_admin', sc.addr(address), sc.addr(admin)),
    removeAdmin: (admin: string) => send('remove_admin', sc.addr(address), sc.addr(admin)),
    setConsensusThreshold: (thresholdBps: number) =>
      send('set_consensus_threshold', sc.addr(address), sc.u32(thresholdBps)),
    setLoanPolicy: (policy: LoanPolicyInput) =>
      send('set_loan_policy', sc.addr(address), policyToScVal(policy)),
    pause: () => send('pause', sc.addr(address)),
    unpause: () => send('unpause', sc.addr(address)),
  }
}

export type DaoWrite = ReturnType<typeof daoWrite>
