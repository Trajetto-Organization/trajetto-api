import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The indexes the schema cannot declare.
 *
 * Most of this product's indexes live in `schema.prisma`, where a missing one
 * is a diff away from being noticed. Three do not, because Prisma has no
 * syntax for them — a GIN trigram index and two shapes on the chat's delete
 * path — and they exist only inside migration files. That makes them exactly
 * the ones that disappear quietly: `migrate dev` compares the database against
 * the schema, sees something the schema never mentions, and offers to drop it.
 * Somebody says yes at the end of a long day and message search goes back to a
 * sequential scan with nothing failing anywhere.
 *
 * What this protects, precisely: the test environment builds a fresh database
 * per file and runs `migrate deploy` into it, so what is asserted here is the
 * state the MIGRATION FILES produce. That is the right target — accepting the
 * `migrate dev` prompt rewrites a migration file, and this fails — but it says
 * nothing about a long-lived database that has drifted. Dropping the index by
 * hand in a running environment leaves these green.
 */
const prisma = createPrismaClient();

afterAll(async () => {
  await prisma.$disconnect();
});

interface IndexRow {
  indexname: string;
  indexdef: string;
}

async function indexesOf(table: string): Promise<IndexRow[]> {
  return prisma.$queryRawUnsafe<IndexRow[]>(
    `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = $1`,
    table,
  );
}

describe("the chat message table", () => {
  it("can find the messages pointing at a delivery", async () => {
    const indexes = await indexesOf("chat_message");

    /**
     * `deliveryId` is ON DELETE SET NULL, so deleting a delivery makes
     * Postgres find every message that points at it. Without an index that is
     * a full scan of the archive, per delivery — and reversing an import
     * deletes them in bulk: 200 deliveries took 11 seconds inside one
     * transaction, against 26 ms with this index.
     *
     * The assertion is that SOMETHING can serve the lookup, not that it is
     * spelled exactly as shipped: a full index instead of the partial one
     * would cost more storage and still be correct.
     */
    const serving = indexes.filter(
      (index) =>
        index.indexdef.includes('"deliveryId"') &&
        // The composite (threadId, created_at, senderId) does not count, and
        // neither would any index where deliveryId is not the leading column.
        /\(\s*"deliveryId"/.test(index.indexdef),
    );

    expect(
      serving.map((index) => index.indexname),
      "no index leads with deliveryId — see 20260919120000_chat_delete_path_indexes",
    ).not.toEqual([]);
  });

  it("can prove a user sent no messages", async () => {
    const indexes = await indexesOf("chat_message");

    // `senderId` is a required relation, so deleting a user makes Postgres
    // prove nothing references them. Measured at 79.7 ms without this index
    // and 0.2 ms with it, on 1.3M messages.
    const serving = indexes.filter((index) =>
      /\(\s*"senderId"/.test(index.indexdef),
    );

    expect(
      serving.map((index) => index.indexname),
      "no index leads with senderId",
    ).not.toEqual([]);
  });

  it("can search message bodies without reading them all", async () => {
    const indexes = await indexesOf("chat_message");

    // Message search is `ILIKE '%term%'`, which no btree can serve. This is
    // the index Prisma most wants to drop, and the one whose loss is hardest
    // to notice: search keeps working, it just reads the whole archive.
    const trigram = indexes.filter(
      (index) =>
        index.indexdef.includes("gin") && index.indexdef.includes("body"),
    );

    expect(
      trigram.map((index) => index.indexname),
      "the trigram index on body is gone — see 20260910120000_chat_scale_indexes",
    ).not.toEqual([]);
  });

  it("still has the index that serves reading a conversation", async () => {
    const indexes = await indexesOf("chat_message");

    // This one IS declared in the schema, so it is here as the control: if
    // this assertion ever fails, the problem is the test's idea of the
    // database rather than a lost index.
    expect(
      indexes.some((index) =>
        /"threadId",\s*created_at,\s*"senderId"/.test(index.indexdef),
      ),
    ).toBe(true);
  });
});

describe("the notification delivery queue", () => {
  /**
   * The cascade from a purged outbox event deletes children by outboxEventId
   * alone. The only indexes starting with that column were PARTIAL, which the
   * cascade cannot use: one sequential scan of the delivery table per event
   * purged, five thousand per batch.
   */
  it("has an index the purge's cascade can use", async () => {
    const indexes = await indexesOf("notification_delivery");

    expect(
      indexes.some(
        (index) =>
          /\(\s*"outboxEventId"\s*\)/.test(index.indexdef) &&
          !index.indexdef.includes("WHERE"),
      ),
    ).toBe(true);
  });

  it("claims each lane from its own partial index", async () => {
    const names = (await indexesOf("notification_delivery")).map(
      (index) => index.indexname,
    );

    expect(names).toContain("notification_delivery_claim_internal_idx");
    expect(names).toContain("notification_delivery_claim_external_idx");
    expect(names).not.toContain("notification_delivery_claim_idx");
  });

  /**
   * The claim spells the lane's channels as literals precisely so the
   * planner can prove the partial index predicate. A generic plan over bound
   * parameters could not, and would walk the whole queue.
   */
  it("uses the lane's index to find the next bell behind a backlog of e-mails", async () => {
    await prisma.$executeRawUnsafe("SET enable_seqscan = off");

    // The claim's shape since PG-19: one range on the index key (the claim
    // writes the lease end into availableAt), ordered by it.
    const plan = await prisma.$queryRawUnsafe<Array<{ "QUERY PLAN": string }>>(`
      EXPLAIN SELECT "id" FROM "notification_delivery"
      WHERE "channel" IN ('IN_APP', 'ACTIVITY', 'PUSH')
        AND "status" IN ('PENDING', 'PROCESSING')
        AND "availableAt" <= now()
        AND ("status" = 'PENDING'
          OR ("leaseExpiresAt" < now() AND "attempts" < 7))
      ORDER BY "availableAt"
      LIMIT 20
    `);

    await prisma.$executeRawUnsafe("RESET enable_seqscan");

    const text = plan.map((row) => row["QUERY PLAN"]).join("\n");

    expect(text).toContain("notification_delivery_claim_internal_idx");

    // A range on the key, not a filter: the scan stops at now().
    expect(text).toMatch(/Index Cond: \("availableAt" <= now\(\)\)/);
  });
});

describe("an access profile's permissions", () => {
  /**
   * Loaded by profile on every authenticated request of a user who has one,
   * and on every socket handshake. The only index was the unique that leads
   * with `action`, so the lookup read the index of every tenant's permissions
   * — a cost that grew with the number of customers, not with anyone's use.
   */
  it("can be found by the profile", async () => {
    const indexes = await indexesOf("permission");

    expect(
      indexes.some((index) =>
        /\(\s*"profileAccessId"\s*[,)]/.test(index.indexdef),
      ),
    ).toBe(true);
  });

  it("and the users of a profile too, for when it is deleted", async () => {
    const indexes = await indexesOf("user");

    expect(
      indexes.some((index) =>
        /\(\s*"profileAccessId"\s*[,)]/.test(index.indexdef),
      ),
    ).toBe(true);
  });
});
