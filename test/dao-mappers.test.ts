import { describe, expect, it } from 'vitest'
import {
  toLoan,
  toMemberStatus,
  asBigInt,
  tag,
  loanStatusCode,
  mapLoanProposal,
  mapTreasuryProposal,
  mapLoan,
  eventLabel,
  resolveLoanPolicy,
} from '@/lib/dao-mappers'
import { MemberStatus } from '@/types/dao'
import {
  PROPOSAL_STATUS_LABELS,
  PROPOSAL_STATUS_AWAITING_FUNDS,
  LOAN_POLICY_FALLBACKS,
  GOVERNANCE_PERIOD_FALLBACKS,
} from '@/constants'
import type { BackendLoan } from '@/lib/backend'

describe('toLoan', () => {
  it('derives amountPaid from amount minus outstanding', () => {
    const l: BackendLoan = {
      id: 1,
      borrower: 'GA',
      amount: '1000',
      outstanding: '400',
      status: 'active',
      approved_ledger: 50,
      repaid_ledger: null,
      defaulted_ledger: null,
      updated_at: '',
    }
    const loan = toLoan(l)
    expect(loan.amount).toBe(BigInt(1000))
    expect(loan.amountPaid).toBe(BigInt(600))
    expect(loan.isActive).toBe(true)
    expect(loan.startTime).toBe(50)
  })

  it('clamps amountPaid to zero rather than going negative', () => {
    const l: BackendLoan = {
      id: 2,
      borrower: 'GA',
      amount: '100',
      outstanding: '150', // shouldn't happen, but must not produce a negative paid amount
      status: 'active',
      approved_ledger: null,
      repaid_ledger: null,
      defaulted_ledger: null,
      updated_at: '',
    }
    expect(toLoan(l).amountPaid).toBe(BigInt(0))
  })

  it('marks a repaid loan as not active', () => {
    const l: BackendLoan = {
      id: 3,
      borrower: 'GA',
      amount: '100',
      outstanding: '0',
      status: 'repaid',
      approved_ledger: 1,
      repaid_ledger: 2,
      defaulted_ledger: null,
      updated_at: '',
    }
    expect(toLoan(l).isActive).toBe(false)
  })

  it('marks a defaulted loan as not active', () => {
    const l: BackendLoan = {
      id: 4,
      borrower: 'GA',
      amount: '100',
      outstanding: '60',
      status: 'defaulted',
      approved_ledger: 1,
      repaid_ledger: null,
      defaulted_ledger: 5,
      updated_at: '',
    }
    expect(toLoan(l).isActive).toBe(false)
  })
})

describe('toMemberStatus', () => {
  it('maps a bare "ActiveMember" symbol to ACTIVE_MEMBER', () => {
    expect(toMemberStatus('ActiveMember')).toBe(MemberStatus.ACTIVE_MEMBER)
  })

  it('maps a one-element array form (as some Soroban enums decode) the same way', () => {
    expect(toMemberStatus(['ActiveMember'])).toBe(MemberStatus.ACTIVE_MEMBER)
  })

  it('maps anything else to INACTIVE_MEMBER', () => {
    expect(toMemberStatus('Inactive')).toBe(MemberStatus.INACTIVE_MEMBER)
    expect(toMemberStatus(undefined)).toBe(MemberStatus.INACTIVE_MEMBER)
  })
})

describe('asBigInt', () => {
  it('passes bigints through', () => {
    expect(asBigInt(BigInt(5))).toBe(BigInt(5))
  })
  it('coerces numbers and numeric strings', () => {
    expect(asBigInt(5)).toBe(BigInt(5))
    expect(asBigInt('5')).toBe(BigInt(5))
  })
  it('falls back to 0 for null/undefined/unparseable input instead of throwing', () => {
    expect(asBigInt(undefined)).toBe(BigInt(0))
    expect(asBigInt(null)).toBe(BigInt(0))
    expect(asBigInt('not a number')).toBe(BigInt(0))
  })
})

describe('tag', () => {
  it('unwraps a one-element array form of a unit enum', () => {
    expect(tag(['Approved'])).toBe('Approved')
  })
  it('stringifies a bare value', () => {
    expect(tag('Approved')).toBe('Approved')
  })
})

describe('loanStatusCode', () => {
  it('maps Approved status to 3', () => {
    expect(loanStatusCode({ status: 'Approved', phase: 'Executed' })).toBe(3)
  })
  it('maps ApprovedPendingDisbursement to the awaiting-funds code', () => {
    expect(loanStatusCode({ status: 'ApprovedPendingDisbursement', phase: 'Executed' })).toBe(
      PROPOSAL_STATUS_AWAITING_FUNDS
    )
  })
  it('maps Executed status to 5', () => {
    expect(loanStatusCode({ status: 'Executed', phase: 'Executed' })).toBe(5)
  })
  it('maps Rejected status, or an Expired phase, to 4', () => {
    expect(loanStatusCode({ status: 'Rejected', phase: 'Voting' })).toBe(4)
    expect(loanStatusCode({ status: 'Pending', phase: 'Expired' })).toBe(4)
  })
  it('maps a Voting phase (still pending) to 2', () => {
    expect(loanStatusCode({ status: 'Pending', phase: 'Voting' })).toBe(2)
  })
  it('maps an Editing phase to 1', () => {
    expect(loanStatusCode({ status: 'Pending', phase: 'Editing' })).toBe(1)
  })
  it('defaults to 0 for anything else', () => {
    expect(loanStatusCode({ status: 'Pending', phase: 'SomethingNew' })).toBe(0)
  })
})

describe('awaiting-funds status (ApprovedPendingDisbursement)', () => {
  it('maps a loan stranded by a short treasury to its own code, not an in-progress one', () => {
    expect(loanStatusCode({ status: 'ApprovedPendingDisbursement', phase: 'Voting' })).toBe(7)
    expect(loanStatusCode({ status: ['ApprovedPendingDisbursement'], phase: 'Expired' })).toBe(7)
  })
  it('maps a treasury proposal stranded by a short treasury to the same code', () => {
    expect(mapTreasuryProposal({ id: 1, status: 'ApprovedPendingDisbursement' }).status).toBe(7)
  })
  it('has a distinct human label', () => {
    expect(PROPOSAL_STATUS_LABELS[7]).toBe('Awaiting Funds')
  })
})

describe('mapLoanProposal', () => {
  it('derives votingStartTime/votingEndTime from editing_period_end + a fixed 7-day window', () => {
    const raw = {
      id: 1,
      borrower: 'GA',
      amount: BigInt(1000),
      interest_rate: 500,
      status: 'Pending',
      phase: 'Voting',
      for_votes: 2,
      against_votes: 1,
      created_at: 100,
      editing_period_end: 1000,
    }
    const p = mapLoanProposal(raw)
    expect(p.votingStartTime).toBe(1000)
    expect(p.votingEndTime).toBe(1000 + 7 * 24 * 60 * 60)
    expect(p.status).toBe(2)
    expect(p.votesFor).toBe(2)
  })

  it('defaults hasVoted to false when no voter context is supplied', () => {
    expect(mapLoanProposal({ id: 1 }).hasVoted).toBe(false)
  })

  it('passes through the real hasVoted value when supplied', () => {
    expect(mapLoanProposal({ id: 1 }, true).hasVoted).toBe(true)
    expect(mapLoanProposal({ id: 1 }, false).hasVoted).toBe(false)
  })
})

describe('mapLoan', () => {
  it('maps the real Loan struct fields, including status as a string tag', () => {
    const l = mapLoan({
      id: 1,
      borrower: 'GBORROWER',
      principal: BigInt(1000),
      interest_rate: 500,
      total_repayment: BigInt(1100),
      start_time: 100,
      due_time: 100 + 30 * 24 * 60 * 60,
      status: 'Active',
      amount_repaid: BigInt(0),
    })
    expect(l.id).toBe(1)
    expect(l.borrower).toBe('GBORROWER')
    expect(l.principal).toBe(BigInt(1000))
    expect(l.totalRepayment).toBe(BigInt(1100))
    expect(l.dueTime).toBe(100 + 30 * 24 * 60 * 60)
    expect(l.status).toBe('Active')
  })

  it('handles a Soroban unit-enum status decoded as a one-element array', () => {
    const l = mapLoan({ status: ['Defaulted'] })
    expect(l.status).toBe('Defaulted')
  })
})

describe('mapTreasuryProposal', () => {
  it('falls back to a generated title when reason is empty', () => {
    const p = mapTreasuryProposal({ id: 7, amount: BigInt(1), destination: 'GD', status: 'Pending' })
    expect(p.title).toBe('Treasury withdrawal #7')
  })
  it('uses the reason as the title when present', () => {
    const p = mapTreasuryProposal({ id: 7, amount: BigInt(1), destination: 'GD', status: 'Pending', reason: 'Pay contractor' })
    expect(p.title).toBe('Pay contractor')
  })
  it('maps Executed/Rejected/else to the right status code', () => {
    expect(mapTreasuryProposal({ id: 1, amount: BigInt(1), destination: 'GD', status: 'Executed' }).status).toBe(5)
    expect(mapTreasuryProposal({ id: 1, amount: BigInt(1), destination: 'GD', status: 'Rejected' }).status).toBe(4)
    expect(mapTreasuryProposal({ id: 1, amount: BigInt(1), destination: 'GD', status: 'Pending' }).status).toBe(2)
  })

  it('defaults hasVoted to false when no voter context is supplied', () => {
    expect(mapTreasuryProposal({ id: 1, amount: BigInt(1), destination: 'GD', status: 'Pending' }).hasVoted).toBe(false)
  })

  it('passes through the real hasVoted value, which the contract also sets for a committed-but-unrevealed private vote', () => {
    const raw = { id: 1, amount: BigInt(1), destination: 'GD', status: 'Pending', private: true }
    // The contract's has_voted view can't distinguish "committed" from
    // "revealed" for a private proposal (see daoRead.hasVoted) — both map
    // to hasVoted: true here, by design, rather than inventing a distinction.
    expect(mapTreasuryProposal(raw, true).hasVoted).toBe(true)
    expect(mapTreasuryProposal(raw, false).hasVoted).toBe(false)
  })
})

describe('eventLabel', () => {
  it('maps a known symbol to its human-readable label', () => {
    expect(eventLabel('loan_dflt')).toBe('Loan defaulted')
    expect(eventLabel('loan_appr')).toBe('Loan approved')
  })
  it.each([
    ['loan_rej', 'Loan proposal rejected'],
    ['loan_wait', 'Loan approved, awaiting treasury funds'],
    ['tre_rej', 'Treasury withdrawal rejected'],
    ['tre_wait', 'Treasury withdrawal approved, awaiting funds'],
  ])('labels the failure event %s', (symbol, label) => {
    expect(eventLabel(symbol)).toBe(label)
  })
  it('falls back to the raw symbol for an unrecognized one', () => {
    expect(eventLabel('some_new_symbol')).toBe('some_new_symbol')
  })
  it('falls back to "Unknown event" for an empty/missing symbol', () => {
    expect(eventLabel(undefined)).toBe('Unknown event')
    expect(eventLabel('')).toBe('Unknown event')
  })
})

describe('resolveLoanPolicy', () => {
  it('uses the chain values when an admin has changed the policy', () => {
    const policy = resolveLoanPolicy(
      { min_interest_rate: 100, max_interest_rate: 3500, max_loan_duration: BigInt(86400) },
      6600
    )
    expect(policy).toEqual({
      minInterestRate: 100,
      maxInterestRate: 3500,
      maxLoanDuration: 86400,
      consensusThreshold: 6600,
      fromChain: true,
    })
  })

  it('falls back, and says so, before the policy has loaded', () => {
    expect(resolveLoanPolicy(undefined, undefined)).toEqual({
      ...LOAN_POLICY_FALLBACKS,
      fromChain: false,
    })
  })

  it('falls back per field for anything missing or non-numeric', () => {
    const policy = resolveLoanPolicy({ min_interest_rate: 'nope', max_interest_rate: 900 }, 5000)
    expect(policy.minInterestRate).toBe(LOAN_POLICY_FALLBACKS.minInterestRate)
    expect(policy.maxInterestRate).toBe(900)
    expect(policy.maxLoanDuration).toBe(LOAN_POLICY_FALLBACKS.maxLoanDuration)
  })

  it('is not from chain when only the policy has arrived', () => {
    expect(resolveLoanPolicy({ min_interest_rate: 100 }, null).fromChain).toBe(false)
  })
})

describe('mapLoanProposal voting end', () => {
  it('ends voting one governance voting period after editing ends', () => {
    const p = mapLoanProposal({ editing_period_end: 1000 })
    expect(p.votingEndTime).toBe(1000 + GOVERNANCE_PERIOD_FALLBACKS.votingPeriod)
  })
})
