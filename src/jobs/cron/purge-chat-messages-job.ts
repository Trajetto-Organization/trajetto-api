import { Prisma } from "@prisma/client";

import { databaseBatch } from "@/../infra/database";
import { env } from "@/env";
import { throwIfPartial } from "@/shared/errors/partial-run-error";
import { logger } from "@/shared/logging/logger";
import { CronJobDefinition } from "@/shared/services/cron-scheduler-service";
import {
  UploadService,
  type StorageDeleteOutcome,
} from "@/shared/services/upload-service";
import { uuid7Floor } from "@/shared/time/uuid7-floor";

import {
  anyLeft,
  deleteInBatches,
  purgeDeadline,
  type BatchDeleteResult,
} from "./batch-delete";

/**
 * The chat's opt-in retention (plano-escala U-08, decision D12).
 *
 * The conversations are the customer's record of what the base told the
 * driver, so nothing is deleted by default: only with
 * CHAT_MESSAGE_RETENTION_DAYS set (a year at least, the env schema refuses
 * less) does this job delete, each night at 04:25 UTC, the messages older
 * than that. Whether to set it is a legal decision first (D12 asks for a
 * lawyer's review): docs/variaveis-de-ambiente.md says so where the value is
 * typed.
 *
 * Finding them. chat_message has no index on created_at alone (its indexes
 * lead with the thread, the sender or the ticket), and a filter on it would
 * read the whole table for every batch. But a message's id is a uuid v7
 * minted when it is written (the one write path, chat-repository.ts
 * createMessage, takes the model's @default(uuid(7))), so its first 48 bits
 * are that millisecond: the messages older than the cutoff are a range of
 * the primary key, walked from its start, with created_at kept as a filter so
 * no message written at or after the cutoff can ever go, whatever its id.
 *
 * The attachments. A photo or a voice note lives in the uploads bucket under
 * chatAttachments/, and the orphan collector would never see it once its
 * message went: it looks only at objects 30 to 33 days old
 * (orphan-uploads.ts). So the messages with an attachment go first, a page
 * at a time: the objects are deleted, and only then the rows whose object is
 * gone. A delete that failed keeps its message, to be tried again in the
 * morning window (the run is partial); one a Bucket Lock refuses keeps it
 * too, for as long as the lock holds the object, without making the run
 * partial (the lock is policy; chatAttachments/ has none today,
 * infra/r2/bucket-locks.md). Either way no object is left without the row
 * that names it. A mass notice shares one object among its messages, all
 * written in the same second: the first page deletes it, and the others go
 * in the same run.
 *
 * Then the messages without one, in the usual batches. Both passes share the
 * run's budget and ceiling, and a run that stops with messages due ends
 * partial (F1-17): the catch-up repeats it in the morning window.
 *
 * Nothing else points at a message (no foreign key references chat_message),
 * and nothing writes one this old: the thread's last_message_at, the read
 * cursors and the tickets stay as they are.
 */
const PURGE_CHAT_MESSAGES_JOB = "purge-chat-messages";

const log = logger.child({ component: "cron", job: PURGE_CHAT_MESSAGES_JOB });

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Messages per run, both passes together. The first night after the
 * retention is set holds every message older than it, and takes several
 * nights, partial, instead of one long delete.
 */
const MAX_CHAT_MESSAGES_PER_RUN = 1_000_000;

/** Messages with an attachment read per page: each costs a storage delete. */
const ATTACHMENT_PAGE_SIZE = 200;

/** Storage deletes in flight at once, as the company purge's (r2-purge.ts). */
const ATTACHMENT_DELETES_IN_FLIGHT = 8;

type AttachmentStorage = Pick<UploadService, "deleteFileOutcome">;

interface ChatRetentionBounds {
  /** Messages written before this instant are past the retention. */
  cutoff: Date;

  /** The smallest uuid v7 of the cutoff: every expired id sorts below it. */
  idBelow: string;
}

interface AttachmentPurgeResult extends BatchDeleteResult {
  /** Messages kept because a Bucket Lock holds their object. */
  retained: number;

  /** Messages kept because their object's delete failed. */
  failed: number;
}

interface ChatPurgeOptions {
  /** Defaults to CHAT_MESSAGE_RETENTION_DAYS; unset, nothing is deleted. */
  retentionDays?: number;
  now?: Date;
  deadline?: number;
  maxRows?: number;
  storage?: AttachmentStorage;
}

function chatRetentionBounds(
  retentionDays: number,
  now: Date = new Date(),
): ChatRetentionBounds {
  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);

  return { cutoff, idBelow: uuid7Floor(cutoff) };
}

/** The expired messages: a range of the primary key, checked by created_at. */
function expiredChatMessages({
  cutoff,
  idBelow,
}: ChatRetentionBounds): Prisma.Sql {
  return Prisma.sql`"id" < ${idBelow} AND "created_at" < ${cutoff}`;
}

/** Deletes `keys`, a few at a time; each one's outcome, in order. */
async function deleteObjects(
  storage: AttachmentStorage,
  keys: readonly string[],
): Promise<StorageDeleteOutcome[]> {
  const outcomes: StorageDeleteOutcome[] = [];

  for (
    let start = 0;
    start < keys.length;
    start += ATTACHMENT_DELETES_IN_FLIGHT
  ) {
    const slice = keys.slice(start, start + ATTACHMENT_DELETES_IN_FLIGHT);

    outcomes.push(
      ...(await Promise.all(
        slice.map((key) => storage.deleteFileOutcome(key)),
      )),
    );
  }

  return outcomes;
}

/**
 * The expired messages with an attachment: a page of them in id order, their
 * objects deleted, then the rows whose object is gone. The cursor moves past
 * every message it read, so one kept on purpose is read once per run.
 */
async function purgeAttachmentMessages(
  expired: Prisma.Sql,
  {
    deadline,
    maxRows,
    storage,
  }: Required<Pick<ChatPurgeOptions, "deadline" | "maxRows" | "storage">>,
): Promise<AttachmentPurgeResult> {
  const result: AttachmentPurgeResult = {
    deleted: 0,
    stoppedEarly: false,
    retained: 0,
    failed: 0,
  };
  const withAttachment = Prisma.sql`${expired} AND "attachment_key" IS NOT NULL`;
  let after: string | null = null;

  for (;;) {
    const pending: Prisma.Sql =
      after === null
        ? withAttachment
        : Prisma.sql`${withAttachment} AND "id" > ${after}`;
    const room = maxRows - result.deleted;

    if (room <= 0 || Date.now() >= deadline) {
      // What this run kept on purpose is behind the cursor: only a failed
      // delete or a message it never reached leaves work due.
      result.stoppedEarly =
        result.failed > 0 ||
        (await anyLeft(Prisma.sql`"chat_message"`, pending));

      return result;
    }

    const page = await databaseBatch.$queryRaw<
      Array<{ id: string; attachment_key: string }>
    >`
      SELECT "id", "attachment_key" FROM "chat_message"
      WHERE ${pending}
      ORDER BY "id"
      LIMIT ${Math.min(ATTACHMENT_PAGE_SIZE, room)}
    `;

    if (page.length === 0) {
      result.stoppedEarly = result.failed > 0;

      return result;
    }

    const outcomes = await deleteObjects(
      storage,
      page.map((message) => message.attachment_key),
    );
    const gone: string[] = [];

    page.forEach((message, index) => {
      if (outcomes[index] === "deleted") gone.push(message.id);
      else if (outcomes[index] === "locked") result.retained += 1;
      else result.failed += 1;
    });

    if (gone.length > 0) {
      result.deleted += await databaseBatch.$executeRaw`
        DELETE FROM "chat_message"
        WHERE "id" = ANY(${gone}::text[]) AND ${expired}
      `;
    }

    after = page[page.length - 1].id;
  }
}

/**
 * Both passes for `retentionDays`; null when the retention is unset, and
 * then nothing is read or deleted.
 */
async function purgeChatMessages({
  retentionDays = env.CHAT_MESSAGE_RETENTION_DAYS,
  now = new Date(),
  deadline = purgeDeadline(now.getTime()),
  maxRows = MAX_CHAT_MESSAGES_PER_RUN,
  storage = new UploadService(),
}: ChatPurgeOptions = {}): Promise<{
  retentionDays: number;
  attachments: AttachmentPurgeResult;
  messages: BatchDeleteResult;
} | null> {
  if (retentionDays === undefined) return null;

  const expired = expiredChatMessages(chatRetentionBounds(retentionDays, now));

  // The smaller pass first, so the big one cannot spend its budget (F1-17).
  const attachments = await purgeAttachmentMessages(expired, {
    deadline,
    maxRows,
    storage,
  });

  const messages = await deleteInBatches({
    table: Prisma.sql`"chat_message"`,
    where: Prisma.sql`${expired} AND "attachment_key" IS NULL`,
    orderBy: Prisma.sql`"id"`,
    maxRows: Math.max(0, maxRows - attachments.deleted),
    deadline,
  });

  return { retentionDays, attachments, messages };
}

/** The run: both passes, the log line, then partial when messages are due. */
async function runChatMessagePurge(
  options: ChatPurgeOptions = {},
): Promise<void> {
  const result = await purgeChatMessages(options);

  if (!result) {
    log.debug("chat retention unset; nothing is deleted");

    return;
  }

  const { retentionDays, attachments, messages } = result;

  log.info(
    {
      retentionDays,
      deleted: {
        withAttachment: attachments.deleted,
        withoutAttachment: messages.deleted,
      },
      retained: attachments.retained,
      failed: attachments.failed,
    },
    "chat messages past their retention purged",
  );

  if (attachments.retained > 0) {
    // Its own line, as the orphan collector's: a lock is policy, not a fault.
    log.warn(
      { retained: attachments.retained },
      "chat messages kept: a bucket lock holds their attachments",
    );
  }

  if (attachments.failed > 0) {
    // Each failure was logged with its key by deleteFileOutcome.
    log.warn(
      { failed: attachments.failed },
      "chat messages kept: their attachments could not be deleted",
    );
  }

  throwIfPartial({
    chat_message_attachments: attachments,
    chat_message: messages,
  });
}

/** Cron: "25 4 * * *" → daily at 04:25 UTC, between the 04:20 and 04:35 purges. */
const purgeChatMessagesJob: CronJobDefinition = {
  name: PURGE_CHAT_MESSAGES_JOB,
  schedule: "25 4 * * *",

  async handler() {
    await runChatMessagePurge();
  },
};

export {
  chatRetentionBounds,
  expiredChatMessages,
  purgeChatMessages,
  purgeChatMessagesJob,
  runChatMessagePurge,
};
