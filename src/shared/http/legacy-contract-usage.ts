/**
 * How often this replica served a deprecated app contract since it started
 * (decisions 14.3 and 14.4): the proof route of contract <= 2 and the pause
 * start that names only `kind`. A legacy adapter is removed after 14 days
 * without a single use (the same rule as the multipart adapter); the
 * structured log line is the cross-replica source, this is the quick look.
 */

type LegacyContractUse = "legacy_proof_adapter" | "legacy_pause_kind";

const counts: Record<LegacyContractUse, number> = {
  legacy_proof_adapter: 0,
  legacy_pause_kind: 0,
};

const lastUseAt: Record<LegacyContractUse, Date | null> = {
  legacy_proof_adapter: null,
  legacy_pause_kind: null,
};

function countLegacyContractUse(use: LegacyContractUse, at: Date = new Date()): void {
  counts[use] += 1;
  lastUseAt[use] = at;
}

/** A snapshot, for /health/metrics. */
function legacyContractUsage(): Record<
  LegacyContractUse,
  { count: number; last_use_at: string | null }
> {
  return {
    legacy_proof_adapter: {
      count: counts.legacy_proof_adapter,
      last_use_at: lastUseAt.legacy_proof_adapter?.toISOString() ?? null,
    },
    legacy_pause_kind: {
      count: counts.legacy_pause_kind,
      last_use_at: lastUseAt.legacy_pause_kind?.toISOString() ?? null,
    },
  };
}

export { countLegacyContractUse, legacyContractUsage };
export type { LegacyContractUse };
