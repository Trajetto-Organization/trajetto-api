import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { v7 as uuidV7 } from "uuid";

import { uploadConfig } from "@/config/upload";
import { env } from "@/env";
import { PartialRunError } from "@/shared/errors/partial-run-error";
import { createPrismaClient } from "@/shared/database/database-client";
import type { StorageDeleteOutcome } from "@/shared/services/upload-service";

import { seedFleetDriver } from "./support/fleet-driver-seed";

/**
 * The chat's opt-in retention (plano-escala U-08, decision D12), on the
 * real table and a real (local) storage.
 *
 * What this pins:
 *  - without CHAT_MESSAGE_RETENTION_DAYS nothing is deleted, however old;
 *  - with 365, the message of 366 days goes and the one of 364 stays, an
 *    attachment's object with its message;
 *  - a message whose object could not be deleted stays (an object no row
 *    points at would never be found again: the orphan collector looks only
 *    at objects 30 to 33 days old) and the run ends partial; one a Bucket
 *    Lock holds stays too, but that is policy, not a partial run;
 *  - a run that stops at its ceiling with messages due ends partial;
 *  - the walk is the primary key's, bounded by the cutoff's id: the table
 *    has no index on created_at alone.
 */
const prisma = createPrismaClient();

const DAY_MS = 24 * 60 * 60 * 1000;

const BUSINESS = "018fc000-0000-7000-8000-0000000000c8";

let threadId = "";
let senderId = "";
let storageRoot = "";

const saved = {
  type: uploadConfig.storage.type,
  localPath: uploadConfig.storage.localPath,
  retention: env.CHAT_MESSAGE_RETENTION_DAYS,
};

const attachmentKey = (name: string, at: number) =>
  `chatAttachments/${BUSINESS}/${at}-${name}-aaaa0001.jpg`;

const stored = (key: string) => fs.existsSync(path.join(storageRoot, key));

function store(key: string): void {
  const file = path.join(storageRoot, key);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "jpeg");
}

/** A message written `daysAgo` days back: its id carries that instant. */
async function seedMessage(
  daysAgo: number,
  attachment?: string,
): Promise<string> {
  const at = new Date(Date.now() - daysAgo * DAY_MS);
  const id = uuidV7({ msecs: at.getTime() });

  if (attachment) store(attachment);

  await prisma.chatMessage.create({
    data: {
      id,
      kind: attachment ? "IMAGE" : "TEXT",
      body: `Mensagem de ${daysAgo} dias`,
      attachment_key: attachment ?? null,
      threadId,
      senderId,
      created_at: at,
    },
  });

  return id;
}

async function idsLeft(): Promise<string[]> {
  const rows = await prisma.chatMessage.findMany({
    select: { id: true },
    orderBy: { id: "asc" },
  });

  return rows.map((row) => row.id);
}

beforeAll(async () => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajetto-chat-ret-"));

  uploadConfig.storage.type = "local";
  uploadConfig.storage.localPath = storageRoot;

  const fleet = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "44555666000188",
  });

  senderId = fleet.driverUserId;
  threadId = (
    await prisma.chatThread.create({
      data: { businessId: BUSINESS, driverId: fleet.driverId },
    })
  ).id;
});

beforeEach(async () => {
  await prisma.chatMessage.deleteMany({});
  env.CHAT_MESSAGE_RETENTION_DAYS = saved.retention;
});

afterAll(async () => {
  env.CHAT_MESSAGE_RETENTION_DAYS = saved.retention;
  uploadConfig.storage.type = saved.type;
  uploadConfig.storage.localPath = saved.localPath;
  fs.rmSync(storageRoot, { recursive: true, force: true });
  await prisma.$disconnect();
});

describe("the chat's retention", () => {
  it("deletes nothing without CHAT_MESSAGE_RETENTION_DAYS, however old", async () => {
    env.CHAT_MESSAGE_RETENTION_DAYS = undefined;

    const old = Date.now() - 3_000 * DAY_MS;
    const photo = attachmentKey("antiga", old);
    const ids = [await seedMessage(3_000), await seedMessage(400, photo)];

    const { purgeChatMessagesJob } =
      await import("@/jobs/cron/purge-chat-messages-job");

    await purgeChatMessagesJob.handler();

    expect(await idsLeft()).toEqual(ids.sort());
    expect(stored(photo)).toBe(true);
  });

  it("with 365 days, removes the message of 366 days and keeps the one of 364, attachments included", async () => {
    env.CHAT_MESSAGE_RETENTION_DAYS = 365;

    const now = Date.now();
    const oldPhoto = attachmentKey("velha", now - 366 * DAY_MS);
    const keptPhoto = attachmentKey("nova", now - 364 * DAY_MS);

    await seedMessage(366);
    await seedMessage(366, oldPhoto);
    const keptText = await seedMessage(364);
    const keptAttachment = await seedMessage(364, keptPhoto);

    const { purgeChatMessagesJob } =
      await import("@/jobs/cron/purge-chat-messages-job");

    await purgeChatMessagesJob.handler();

    expect(await idsLeft()).toEqual([keptText, keptAttachment].sort());
    expect(stored(oldPhoto)).toBe(false);
    expect(stored(keptPhoto)).toBe(true);
  });

  it("keeps a message whose object stays, and ends partial only when a delete failed", async () => {
    const at = Date.now() - 400 * DAY_MS;
    const failing = attachmentKey("falha", at);
    const locked = attachmentKey("travada", at + 1);
    const deletable = attachmentKey("apaga", at + 2);

    const failingId = await seedMessage(400, failing);
    const lockedId = await seedMessage(400, locked);
    await seedMessage(400, deletable);

    const answers: Record<string, StorageDeleteOutcome> = {
      [failing]: "failed",
      [locked]: "locked",
      [deletable]: "deleted",
    };
    const storage = {
      deleteFileOutcome: async (key: string) => answers[key] ?? "deleted",
    };

    const { runChatMessagePurge } =
      await import("@/jobs/cron/purge-chat-messages-job");

    const first = runChatMessagePurge({ retentionDays: 365, storage });

    await expect(first).rejects.toBeInstanceOf(PartialRunError);
    await expect(first).rejects.toThrow(/chat_message_attachments/);
    expect(await idsLeft()).toEqual([failingId, lockedId].sort());

    // The storage is back: the failed one goes. The locked one stays, and
    // that alone is not a partial run, or it would page every night.
    answers[failing] = "deleted";

    await expect(
      runChatMessagePurge({ retentionDays: 365, storage }),
    ).resolves.toBeUndefined();
    expect(await idsLeft()).toEqual([lockedId]);
  });

  it("ends partial when a run stops at its ceiling with messages due", async () => {
    await seedMessage(402);
    const second = await seedMessage(401);
    const third = await seedMessage(400);

    const { runChatMessagePurge } =
      await import("@/jobs/cron/purge-chat-messages-job");

    const run = runChatMessagePurge({ retentionDays: 365, maxRows: 1 });

    await expect(run).rejects.toBeInstanceOf(PartialRunError);
    await expect(run).rejects.toThrow(/chat_message\b/);

    // The oldest went first.
    expect(await idsLeft()).toEqual([second, third]);
  });

  it("walks the primary key, bounded by the cutoff's id", async () => {
    const { chatRetentionBounds, expiredChatMessages } =
      await import("@/jobs/cron/purge-chat-messages-job");

    const bounds = chatRetentionBounds(365, new Date());

    const plan = await prisma.$transaction(async (tx) => {
      // On a handful of rows the planner would rather read the table and
      // sort; with those paths off, what is left answers the one question:
      // can the walk stop at the cutoff (an Index Cond on the id), or does
      // it read every message (a Filter only)?
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_bitmapscan = off");
      await tx.$executeRawUnsafe("SET LOCAL enable_sort = off");

      return tx.$queryRaw<Array<{ "QUERY PLAN": unknown }>>`
        EXPLAIN (FORMAT JSON)
        SELECT "id" FROM "chat_message"
        WHERE ${expiredChatMessages(bounds)} AND "attachment_key" IS NULL
        ORDER BY "id"
        LIMIT 5000
      `;
    });

    const text = JSON.stringify(plan[0]["QUERY PLAN"]);

    expect(text).toContain('"Index Name":"chat_message_pkey"');
    expect(text).toMatch(/"Index Cond":"\(id < /);
    expect(text).not.toContain('"Node Type":"Seq Scan"');
  });

  // The volume is what decides whether the retention is ever turned on: the
  // table's rows (hot_tables) and its size go into the cluster's row of
  // ops_sample every minute, with the other watched tables.
  it("is measured: the table's size is in the database sample", async () => {
    const { HOT_TABLES, databaseSizesSql } =
      await import("@/shared/health/metrics-queries");

    expect(HOT_TABLES).toContain("chat_message");

    const [row] =
      await prisma.$queryRaw<
        Array<{ tables: Array<{ table_name: string; total_bytes: number }> }>
      >(databaseSizesSql());

    expect(row.tables).toContainEqual({
      table_name: "chat_message",
      total_bytes: expect.any(Number),
    });
  });
});
