/**
 * The differences between the migrated database and prisma/schema.prisma
 * that are there on purpose (plano-escala F2-02).
 *
 * tests/E2E/schema-drift.test.ts runs `prisma migrate diff` from the E2E
 * database (every migration applied, then infra/sql and prisma/post-deploy,
 * as a release leaves it) to the schema, and fails on any statement that is
 * not listed here. Each entry says why the schema cannot (or must not) say
 * what the migration did. An entry that comes from a temporary state (the
 * `*_legacy` tables of the history window, a column between expand and
 * contract) carries `until`, the UTC day after which it fails the gate: the
 * state was meant to end, and an old entry would hide a real drift. An
 * entry that matches nothing fails too: it is dead, take it out.
 *
 * `statement` is the normalized SQL of one statement as the diff prints it
 * (comments out, whitespace collapsed, no trailing `;`), or a RegExp over
 * it.
 */
interface DriftAllowance {
  statement: string | RegExp;
  why: string;
  /** YYYY-MM-DD (UTC): from the day after, the entry fails the gate. */
  until?: string;
}

const SCHEMA_DRIFT_ALLOWLIST: readonly DriftAllowance[] = [
  {
    statement: 'DROP INDEX "chat_message_body_trgm_idx"',
    why: "The chat search's trigram GIN index (gin_trgm_ops), created only by migration 20260910120000_chat_scale_indexes. The schema does not declare it, and `prisma migrate dev` keeps proposing its DROP, which was removed by hand from 20260914163141 and 20260914163752.",
  },
  {
    statement: 'DROP INDEX "support_ticket_closed_inbox_idx"',
    why: 'The "Encerrados" inbox orders by closed_at DESC NULLS LAST, which Prisma cannot declare: raw SQL in migration 20261007120000_db_perf_indexes, noted on the SupportTicket model.',
  },
  {
    statement: 'DROP INDEX "support_ticket_all_inbox_idx"',
    why: 'The "Todos" inbox orders by last_message_at DESC NULLS LAST, which Prisma cannot declare: raw SQL in migration 20261007120000_db_perf_indexes, noted on the SupportTicket model.',
  },
];

export { SCHEMA_DRIFT_ALLOWLIST, type DriftAllowance };
