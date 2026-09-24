/** Basis-point denominator. A genuine constant, not a policy value. */
export const BASIS_POINTS = 10000

/**
 * Pre-load fallbacks for values the contract owns. Every one has an on-chain
 * counterpart (`get_loan_policy` / `get_consensus_threshold`) that an admin can
 * change via `set_loan_policy` / `set_consensus_threshold`, so never compute
 * against these once the policy has loaded: use `resolveLoanPolicy` /
 * `useLoanPolicy`, which prefer the chain's values.
 */
export const LOAN_POLICY_FALLBACKS = {
  minInterestRate: 500, // 5% in basis points
  maxInterestRate: 2000, // 20% in basis points
  maxLoanDuration: 365 * 24 * 60 * 60, // 1 year in seconds
  consensusThreshold: 5100, // 51%
} as const

/**
 * Governance periods the contract enforces but does not expose through any
 * view, so they cannot be read yet. They are assumptions and may drift from
 * the chain; replace with a contract read as soon as one exists.
 */
export const GOVERNANCE_PERIOD_FALLBACKS = {
  editingPeriod: 3 * 24 * 60 * 60, // 3 days in seconds
  votingPeriod: 7 * 24 * 60 * 60, // 7 days in seconds
} as const

export const MEMBER_STATUS_LABELS = {
  1: 'Active Member',
  2: 'Inactive Member',
} as const

// A non-member has no contract record at all, so there is no status code for it.
export const NON_MEMBER_LABEL = 'Non-Member'

export const PROPOSAL_STATUS_LABELS = {
  0: 'Pending',
  1: 'In Editing',
  2: 'In Voting',
  3: 'Approved',
  4: 'Rejected',
  5: 'Executed',
  7: 'Awaiting Funds',
} as const

/** Approved by vote, but the treasury was too small to pay out; the contract
 *  keeps the proposal as `ApprovedPendingDisbursement` until it is funded. */
export const PROPOSAL_STATUS_AWAITING_FUNDS = 7

const DEFAULT_IPFS_GATEWAY = 'https://gateway.pinata.cloud/ipfs/'

/** Parse a comma-separated gateway list, dropping blanks and adding a trailing
 *  slash so `${gateway}${cid}` is always well-formed. Falls back to the default. */
export function parseGatewayList(raw: string | undefined): string[] {
  const list = (raw ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => (g.endsWith('/') ? g : `${g}/`))
  return list.length > 0 ? list : [DEFAULT_IPFS_GATEWAY]
}

/** Read gateways in priority order; NEXT_PUBLIC_IPFS_GATEWAY may list several. */
export const IPFS_GATEWAYS = parseGatewayList(process.env.NEXT_PUBLIC_IPFS_GATEWAY)

/** Primary gateway, used for links shown to the user. */
export const IPFS_GATEWAY = IPFS_GATEWAYS[0]

/** Give up on one gateway after this long and move on to the next. */
export const IPFS_GATEWAY_TIMEOUT_MS = 10_000
