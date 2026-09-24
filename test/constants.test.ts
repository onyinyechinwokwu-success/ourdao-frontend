import { describe, expect, it } from 'vitest'
import {
  BASIS_POINTS,
  GOVERNANCE_PERIOD_FALLBACKS,
  LOAN_POLICY_FALLBACKS,
  PROPOSAL_STATUS_LABELS,
  parseGatewayList,
} from '@/constants'

describe('PROPOSAL_STATUS_LABELS', () => {
  it('has no label for a cancelled state the contract cannot produce', () => {
    expect(Object.values(PROPOSAL_STATUS_LABELS)).not.toContain('Cancelled')
  })
  it('labels the pending-disbursement state', () => {
    expect(PROPOSAL_STATUS_LABELS[7]).toBe('Awaiting Funds')
  })
})

describe('parseGatewayList', () => {
  it('falls back to the default gateway when unset or blank', () => {
    expect(parseGatewayList(undefined)).toEqual(['https://gateway.pinata.cloud/ipfs/'])
    expect(parseGatewayList(' , ')).toEqual(['https://gateway.pinata.cloud/ipfs/'])
  })
  it('keeps a single gateway, normalising the trailing slash', () => {
    expect(parseGatewayList('https://a.example/ipfs')).toEqual(['https://a.example/ipfs/'])
  })
  it('splits a comma-separated list in order, trimming whitespace', () => {
    expect(parseGatewayList('https://a.example/ipfs/, https://b.example/ipfs')).toEqual([
      'https://a.example/ipfs/',
      'https://b.example/ipfs/',
    ])
  })
})

describe('policy fallbacks', () => {
  it('keeps the previous pre-load values', () => {
    expect(LOAN_POLICY_FALLBACKS).toEqual({
      minInterestRate: 500,
      maxInterestRate: 2000,
      maxLoanDuration: 365 * 24 * 60 * 60,
      consensusThreshold: 5100,
    })
    expect(GOVERNANCE_PERIOD_FALLBACKS.votingPeriod).toBe(7 * 24 * 60 * 60)
    expect(GOVERNANCE_PERIOD_FALLBACKS.editingPeriod).toBe(3 * 24 * 60 * 60)
    expect(BASIS_POINTS).toBe(10000)
  })
})
