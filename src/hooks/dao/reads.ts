'use client'

import { useQuery } from '@tanstack/react-query'
import { useWallet } from '@/lib/wallet'
import { CONTRACT_ID, isContractConfigured } from '@/lib/stellar'
import { daoRead } from '@/lib/dao-client'
import { backend } from '@/lib/backend'
import type { UserData, DAOStats } from '@/types/dao'
import { asBigInt, resolveLoanPolicy, toLoan, toMemberStatus } from '@/lib/dao-mappers'
import type { UILoanPolicy } from '@/lib/dao-mappers'

export function useDAOContract() {
  return { contractId: CONTRACT_ID, configured: isContractConfigured() }
}

/** Aggregated data for the connected member. */
export function useUserData(): UserData {
  const { address, isConnected } = useWallet()

  const { data, isLoading } = useQuery({
    queryKey: ['userData', address],
    enabled: !!address && isContractConfigured(),
    queryFn: async () => {
      const [isMember, isAdmin, member, pendingYield] = await Promise.all([
        daoRead.isMember(address!),
        daoRead.isAdmin(address!),
        daoRead.getMember(address!),
        daoRead.getPendingYield(address!),
      ])
      return { isMember, isAdmin, member, pendingYield }
    },
  })

  // Loan history comes from the off-chain indexer (the contract keeps no
  // queryable per-member loan list). Independent of contract configuration so
  // it still resolves when only the backend URL is set.
  const { data: loans } = useQuery({
    queryKey: ['userLoans', address],
    enabled: !!address,
    queryFn: () => backend.getLoans(address!),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })

  const m = data?.member
  return {
    isConnected,
    isLoading,
    address: address || undefined,
    isMember: !!data?.isMember,
    isAdmin: !!data?.isAdmin,
    member: m
      ? {
          memberAddress: String(m.address ?? address),
          status: toMemberStatus(m.status),
          joinDate: Number(m.join_ledger ?? 0),
          contributionAmount: asBigInt(m.contribution),
          shareBalance: asBigInt(m.share_balance),
          hasActiveLoan: !!m.has_active_loan,
          lastLoanDate: Number(m.last_loan_time ?? 0),
        }
      : undefined,
    votingWeight: 1,
    pendingRewards: asBigInt(data?.pendingYield),
    pendingYield: asBigInt(data?.pendingYield),
    hasActiveLoan: !!m?.has_active_loan,
    loans: (loans ?? []).map(toLoan),
  }
}

export type ExtendedStats = DAOStats & {
  initialized: boolean
  isPaused: boolean
  membershipFee: bigint
  /** Policy cap on a loan as basis points of the treasury balance. */
  maxLoanToTreasuryRatio: number
  consensusThreshold: number
  features: {
    ensVoting: boolean
    documentStorage: boolean
    privateVoting: boolean
    confidentialLoans: boolean
    restaking: boolean
  }
}

/** The loan policy as the contract currently has it. An admin can change it at
 *  any time, so it is refetched rather than cached forever; until the first
 *  read lands the labelled fallbacks stand in (`fromChain` is false). */
export function useLoanPolicy(): UILoanPolicy {
  const { data } = useQuery({
    queryKey: ['loanPolicy'],
    enabled: isContractConfigured(),
    queryFn: async () => {
      const [policy, threshold] = await Promise.all([
        daoRead.getLoanPolicy(),
        daoRead.getConsensusThreshold(),
      ])
      return { policy, threshold }
    },
  })
  return resolveLoanPolicy(data?.policy, data?.threshold)
}

export function useDAOStats(): ExtendedStats {
  const { data } = useQuery({
    queryKey: ['daoStats'],
    enabled: isContractConfigured(),
    queryFn: async () => {
      const [totalMembers, activeMembers, threshold, treasury, policy, isPaused] =
        await Promise.all([
          daoRead.getTotalMembers(),
          daoRead.getActiveMembers(),
          daoRead.getConsensusThreshold(),
          daoRead.getTreasuryBalance(),
          daoRead.getLoanPolicy(),
          daoRead.isPaused(),
        ])
      return { totalMembers, activeMembers, threshold, treasury, policy, isPaused }
    },
  })

  // Loan counts and total stake are aggregated by the off-chain indexer, which
  // sees the full event history the contract doesn't keep queryable.
  const { data: agg } = useQuery({
    queryKey: ['daoStatsBackend'],
    queryFn: () => backend.getStats(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })

  const membershipFee = asBigInt(
    (data?.policy as Record<string, unknown> | undefined)?.membership_contribution
  )

  const maxLoanToTreasuryRatio = Number(
    (data?.policy as Record<string, unknown> | undefined)?.max_loan_to_treasury_ratio ?? 0
  )

  return {
    totalMembers: Number(data?.totalMembers ?? 0),
    activeMembers: Number(data?.activeMembers ?? 0),
    totalLoans: agg?.totalLoans ?? 0,
    activeLoans: agg?.activeLoans ?? 0,
    treasuryBalance: asBigInt(data?.treasury),
    totalYieldGenerated: BigInt(0),
    totalRestaked: asBigInt(agg?.totalStaked),
    initialized: isContractConfigured() && data?.threshold != null,
    isPaused: !!data?.isPaused,
    membershipFee,
    maxLoanToTreasuryRatio,
    consensusThreshold: Number(data?.threshold ?? 0),
    // The Soroban port's native modules are always compiled in.
    features: {
      ensVoting: true, // name registry
      documentStorage: true, // content-hash metadata
      privateVoting: true, // commit-reveal
      confidentialLoans: false,
      restaking: true, // staking
    },
  }
}

// Contract events, indexed off-chain by ourdao-backend (which polls the RPC's
// getEvents) and served from its raw event feed. Kept read-only; `setEvents`
// remains for call-site compatibility with the previous shell.
export function useDAOEvents() {
  const { data } = useQuery({
    queryKey: ['daoEvents'],
    queryFn: () => backend.getEvents(50),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  })
  const events = (data ?? []) as unknown as Record<string, unknown>[]
  const setEvents = () => {}
  return { events, setEvents }
}
