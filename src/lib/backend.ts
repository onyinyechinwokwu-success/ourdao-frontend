'use client'

/**
 * Client for the OurDAO backend (ourdao-backend) — the off-chain indexer +
 * read API. The Soroban contract stays the source of truth for writes and
 * live member/treasury reads; the backend supplies history and aggregates the
 * chain can't cheaply serve (loan history, notifications, the event feed).
 *
 * Every call fails soft: if the backend is unreachable or not configured, the
 * helpers resolve to empty/null so the UI degrades to its on-chain-only state
 * rather than throwing.
 */

// Read at call time, like isBackendConfigured(), so the two can never disagree
// about whether (or where) a backend is configured.
const backendUrl = (): string => process.env.NEXT_PUBLIC_BACKEND_URL || ''

export const BACKEND_URL = backendUrl()

export const isBackendConfigured = (): boolean => !!backendUrl()

// --- Response shapes (mirror ourdao-backend/src/types.ts; amounts are strings) ---

export interface BackendStats {
  totalMembers: number
  activeMembers: number
  totalLoanProposals: number
  totalLoans: number
  activeLoans: number
  totalTreasuryProposals: number
  totalStaked: string
  lastIndexedLedger: number | null
}

export interface BackendLoan {
  id: number
  borrower: string
  amount: string
  outstanding: string
  status: 'active' | 'repaid' | 'defaulted'
  approved_ledger: number | null
  repaid_ledger: number | null
  defaulted_ledger: number | null
  updated_at: string
}

export interface BackendNotification {
  id: number
  address: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  message: string
  ledger: number | null
  tx_hash: string | null
  read: boolean
  created_at: string
}

export interface BackendEvent {
  id: string
  ledger: number
  closed_at: string
  contract_id: string
  symbol: string
  topics: unknown
  data: unknown
  tx_hash: string | null
  created_at: string
}

// --- Fetch helper -----------------------------------------------------------

// None of these fetches set a timeout or abort signal, so a hung indexer leaves
// a request pending indefinitely instead of degrading to the on-chain-only state.

async function get<T>(path: string, fallback: T): Promise<T> {
  if (!isBackendConfigured()) return fallback
  try {
    const res = await fetch(`${backendUrl()}${path}`, {
      headers: { accept: 'application/json' },
      // Indexed data changes often; never serve a stale cache.
      cache: 'no-store',
    })
    if (!res.ok) return fallback
    return (await res.json()) as T
  } catch {
    // Backend down / CORS / network — degrade gracefully.
    return fallback
  }
}

/** PATCH with no body. Returns whether the backend accepted the mutation. */
async function patch(path: string): Promise<boolean> {
  if (!isBackendConfigured()) return false
  try {
    const res = await fetch(`${backendUrl()}${path}`, { method: 'PATCH' })
    return res.ok
  } catch {
    return false
  }
}

// --- Endpoints --------------------------------------------------------------

export const backend = {
  getStats: () => get<BackendStats | null>('/api/stats', null),

  getLoans: (borrower?: string) =>
    get<BackendLoan[]>(
      borrower ? `/api/loans?borrower=${encodeURIComponent(borrower)}` : '/api/loans',
      []
    ),

  getLoan: (id: number) => get<BackendLoan | null>(`/api/loans/${id}`, null),

  getNotifications: (address: string, limit = 50) =>
    get<BackendNotification[]>(
      `/api/notifications?address=${encodeURIComponent(address)}&limit=${limit}`,
      []
    ),

  getEvents: (limit = 50, symbol?: string) =>
    get<BackendEvent[]>(
      symbol
        ? `/api/events?symbol=${encodeURIComponent(symbol)}&limit=${limit}`
        : `/api/events?limit=${limit}`,
      []
    ),

  getAdminLog: (limit = 50) => get<BackendEvent[]>(`/api/admin/log?limit=${limit}`, []),

  markNotificationRead: (id: number) => patch(`/api/notifications/${id}/read`),

  markAllNotificationsRead: (address: string) =>
    patch(`/api/notifications/read-all?address=${encodeURIComponent(address)}`),
}
