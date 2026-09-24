import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useLoanPolicy } from '@/hooks/dao/reads'
import { LOAN_POLICY_FALLBACKS } from '@/constants'
import type { UILoanPolicy } from '@/lib/dao-mappers'

const mockGetLoanPolicy = vi.fn()
const mockGetConsensusThreshold = vi.fn()

vi.mock('@/lib/stellar', async () => {
  const actual = await vi.importActual<typeof import('@/lib/stellar')>('@/lib/stellar')
  return { ...actual, isContractConfigured: () => true }
})

vi.mock('@/lib/dao-client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/dao-client')>('@/lib/dao-client')
  return {
    ...actual,
    daoRead: {
      ...actual.daoRead,
      getLoanPolicy: (...a: unknown[]) => mockGetLoanPolicy(...a),
      getConsensusThreshold: (...a: unknown[]) => mockGetConsensusThreshold(...a),
    },
  }
})

function Harness({ onRender }: { onRender: (p: UILoanPolicy) => void }) {
  onRender(useLoanPolicy())
  return null
}

function mount(onRender: (p: UILoanPolicy) => void) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <Harness onRender={onRender} />
    </QueryClientProvider>
  )
}

describe('useLoanPolicy', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it('starts on the labelled fallbacks, then switches to what the contract returns', async () => {
    mockGetLoanPolicy.mockResolvedValue({
      min_interest_rate: 250,
      max_interest_rate: 4000,
      max_loan_duration: BigInt(1000),
    })
    mockGetConsensusThreshold.mockResolvedValue(7500)
    const seen: UILoanPolicy[] = []

    mount((p) => seen.push(p))

    expect(seen[0]).toEqual({ ...LOAN_POLICY_FALLBACKS, fromChain: false })
    await waitFor(() => expect(seen.at(-1)?.fromChain).toBe(true))
    expect(seen.at(-1)).toEqual({
      minInterestRate: 250,
      maxInterestRate: 4000,
      maxLoanDuration: 1000,
      consensusThreshold: 7500,
      fromChain: true,
    })
  })
})
