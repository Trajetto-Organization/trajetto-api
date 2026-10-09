import database from "@/../infra/database";

import type { UploadType } from "@/config/upload";
import { logger } from "@/shared/logging/logger";
import { UploadService } from "@/shared/services/upload-service";

const log = logger.child({ component: "cron", job: "cleanup-orphan-uploads" });

/**
 * Collects objects that reached storage and never became a row.
 *
 * A presigned PUT lands bytes in the bucket before the client submits the
 * form that references them, and plenty of uploads never get that far: a form
 * abandoned after the photo went up, a head check that refused the object, a
 * cleanup delete that failed. Nothing ever removed those, and nothing counted
 * them either.
 *
 * ADR 0006 is the constraint: an object belongs to the client's retry until
 * the record exists, and in doubt it stays. So this is narrow by construction:
 *
 *   - only keys in the presigned format, which carries the upload timestamp
 *     (`<type>/<scope>/<13-digit ms>-<name>-<id>.<ext>`). Any other shape is
 *     legacy and never looked at;
 *   - only objects 30 to 33 days old. Thirty days is far past any retry the
 *     app's outbox makes in practice — and a submission that does arrive
 *     later finds UPLOADED_FILE_NOT_FOUND, which the app answers by uploading
 *     the photo again from the device. The three-day span gives every object
 *     three nightly chances, so a missed night loses nothing;
 *   - dry-run by default (UPLOAD_ORPHAN_GC): it counts and logs, and deletes
 *     only once somebody has read those counts and switched it on.
 *
 * Residual, accepted: a submission delayed past thirty days whose head check
 * passes in the same instant this deletes that key. The app's re-upload
 * covers the ordinary "object gone" case; this one would need both to
 * happen within the same second, a month after the photo was taken.
 */
type OrphanGcMode = "off" | "dry-run" | "delete";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Younger than this is never an orphan: it may still be a retry. */
const MIN_AGE_DAYS = 30;

/** How far past MIN_AGE_DAYS a run looks: each object gets this many runs. */
const WINDOW_DAYS = 3;

/** Under the scheduler's 10-minute execution lease, with room to log. */
const RUN_BUDGET_MS = 8 * 60 * 1000;

/** Storage and database calls in flight at once. */
const CONCURRENCY = 4;

const PAGE_SIZE = 1000;

/** Orphan keys named in the summary, so a dry run can be spot-checked. */
const SAMPLE_SIZE = 5;

interface OrphanWindow {
  startMs: number;
  endMs: number;
}

interface KeyRange {
  /** Inclusive lower bound of the keys in the window, as a string. */
  lo: string;
  /** Exclusive upper bound. */
  hi: string;
}

interface ReferenceQuery extends KeyRange {
  scopeId: string;

  /** The window's keys under this scope, for lookups by exact key. */
  keys: string[];

  /**
   * Rows of append-only tables older than this cannot reference a key in the
   * window: the row is written after the upload, never re-pointed later.
   */
  since: Date;
}

interface NamespaceSpec {
  /**
   * How the namespace's keys are grouped under it: one prefix per business,
   * listed business by business, or per user (avatars), listed as a whole
   * because there are far more users than businesses.
   */
  scope: "business" | "user";

  /** The keys among the window's that a row still points at. */
  referenced(query: ReferenceQuery): Promise<Set<string>>;
}

type ClientUploadType = Exclude<UploadType, "deliveryProofs">;

const PRESIGNED_KEY = /^[^/]+\/[^/]+\/(\d{13})-[^/]*$/;

/** The upload time a presigned key carries, or null for any other shape. */
function keyTimestamp(key: string): number | null {
  const match = PRESIGNED_KEY.exec(key);

  return match ? Number(match[1]) : null;
}

function orphanWindow(now: number): OrphanWindow {
  return {
    startMs: now - (MIN_AGE_DAYS + WINDOW_DAYS) * DAY_MS,
    endMs: now - MIN_AGE_DAYS * DAY_MS,
  };
}

/**
 * The window as a range of key strings under `prefix`. The timestamps are
 * all 13 digits, so string order is numeric order: the bucket lists them in
 * this order, and a btree compares them the same way.
 */
function keyRange(prefix: string, window: OrphanWindow): KeyRange {
  return {
    lo: `${prefix}${window.startMs}`,
    hi: `${prefix}${window.endMs + 1}`,
  };
}

const keysOf = (rows: Array<{ key: string | null }>) =>
  new Set(rows.map((row) => row.key).filter((key): key is string => !!key));

/**
 * Where each client-written namespace is referenced from.
 *
 * A Record, so a new upload type does not compile until somebody says where
 * its keys are stored — the failure that matters here is a column this list
 * does not know about, which would make every object in it look orphaned.
 * `deliveryProofs` is left out on purpose: the server writes those, under a
 * key the delivery owns, and nothing but the proof flow replaces them.
 *
 * Every value is stored as the raw key (`resolvePresignedUploads` returns the
 * key as the path, and every caller persists that), which is what lets the
 * lookups compare ranges instead of scanning for substrings.
 */
const ORPHAN_GC_NAMESPACES: Record<ClientUploadType, NamespaceSpec> = {
  odometerPhotos: {
    scope: "business",
    // Not bounded by time: an edit may point an old fueling at a new photo.
    referenced: async ({ scopeId, lo, hi }) =>
      keysOf(
        await database.$queryRaw<Array<{ key: string }>>`
          SELECT "odometer_photo" AS key
          FROM "fuel"
          WHERE "businessId" = ${scopeId}
            AND "odometer_photo" >= ${lo} AND "odometer_photo" < ${hi}
        `,
      ),
  },

  checklistPhotos: {
    scope: "business",
    // Both the flat list and the per-field mapping, every string at any
    // depth of the mapping, so a reshaped mapping cannot hide a live photo.
    // Not bounded by time: an edit may add photos to an old checklist.
    referenced: async ({ scopeId, lo, hi }) =>
      keysOf(
        await database.$queryRaw<Array<{ key: string }>>`
          SELECT p AS key
          FROM "vehicle_checklist" v, unnest(v."photos") AS p
          WHERE v."businessId" = ${scopeId} AND p >= ${lo} AND p < ${hi}
          UNION
          SELECT s #>> '{}' AS key
          FROM "vehicle_checklist" v,
            jsonb_path_query(
              v."photos_by_field",
              'strict $.** ? (@.type() == "string")'
            ) AS s
          WHERE v."businessId" = ${scopeId}
            AND v."photos_by_field" IS NOT NULL
            AND (s #>> '{}') >= ${lo} AND (s #>> '{}') < ${hi}
        `,
      ),
  },

  deliveryPhotos: {
    scope: "business",
    // Receipt, signature and occurrence photos share the namespace. Both
    // tables are append-only, so the business's recent rows are enough.
    referenced: async ({ scopeId, lo, hi, since }) =>
      keysOf(
        await database.$queryRaw<Array<{ key: string }>>`
          SELECT "photo" AS key
          FROM "delivery_event"
          WHERE "businessId" = ${scopeId} AND "created_at" >= ${since}
            AND "photo" >= ${lo} AND "photo" < ${hi}
          UNION
          SELECT "signature" AS key
          FROM "delivery_event"
          WHERE "businessId" = ${scopeId} AND "created_at" >= ${since}
            AND "signature" >= ${lo} AND "signature" < ${hi}
          UNION
          SELECT p AS key
          FROM "delivery_occurrence" o, unnest(o."photos") AS p
          WHERE o."businessId" = ${scopeId} AND o."created_at" >= ${since}
            AND p >= ${lo} AND p < ${hi}
          UNION
          -- Decision 14.3: the receipt and signature of an occurrence. A
          -- PENDING/SUPERSEDED delivery request or a NOT_DELIVERED one holds
          -- them ONLY here (no PROOF event), so missing them deletes a legal record.
          SELECT "receipt_photo" AS key
          FROM "delivery_occurrence"
          WHERE "businessId" = ${scopeId} AND "created_at" >= ${since}
            AND "receipt_photo" >= ${lo} AND "receipt_photo" < ${hi}
          UNION
          SELECT "signature" AS key
          FROM "delivery_occurrence"
          WHERE "businessId" = ${scopeId} AND "created_at" >= ${since}
            AND "signature" >= ${lo} AND "signature" < ${hi}
        `,
      ),
  },

  chatAttachments: {
    scope: "business",
    // Photos and voice notes; a message is never re-pointed at another key.
    referenced: async ({ scopeId, lo, hi, since }) =>
      keysOf(
        await database.$queryRaw<Array<{ key: string }>>`
          SELECT m."attachment_key" AS key
          FROM "chat_message" m
          JOIN "chat_thread" t ON t."id" = m."threadId"
          WHERE t."businessId" = ${scopeId} AND m."created_at" >= ${since}
            AND m."attachment_key" >= ${lo} AND m."attachment_key" < ${hi}
        `,
      ),
  },

  avatars: {
    scope: "user",
    referenced: async ({ keys }) =>
      keys.length === 0
        ? new Set()
        : keysOf(
            await database.$queryRaw<Array<{ key: string }>>`
              SELECT "avatar" AS key
              FROM "user"
              WHERE "avatar" = ANY(${keys}::text[])
            `,
          ),
  },
};

interface OrphanGcSummary {
  mode: Exclude<OrphanGcMode, "off">;
  scopes: number;
  scanned: number;
  referenced: number;
  orphaned: number;
  deleted: number;
  failed: number;

  /** Scopes skipped because their listing or reference lookup failed. */
  errors: number;

  stoppedEarly: boolean;
  sample: string[];
}

interface RunOptions {
  mode: OrphanGcMode;
  now?: number;
  budgetMs?: number;
  uploadService?: Pick<UploadService, "listObjectKeys" | "tryDeleteFile">;
}

/** Every key under `prefix` whose timestamp falls in the window. */
async function listWindow(
  uploads: Pick<UploadService, "listObjectKeys">,
  prefix: string,
  window: OrphanWindow,
  bounded: boolean,
): Promise<string[]> {
  const { lo, hi } = keyRange(prefix, window);
  const found: string[] = [];

  // A scoped prefix starts listing at the window. A whole namespace (avatars)
  // is ordered by user first, so it is read to the end and filtered.
  let cursor: string | undefined = bounded ? lo : undefined;

  for (;;) {
    const page = await uploads.listObjectKeys(prefix, cursor, PAGE_SIZE);

    for (const key of page) {
      if (bounded && key >= hi) return found;

      const timestamp = keyTimestamp(key);

      if (
        timestamp !== null &&
        timestamp >= window.startMs &&
        timestamp <= window.endMs
      ) {
        found.push(key);
      }
    }

    if (page.length < PAGE_SIZE) return found;

    cursor = page[page.length - 1];
  }
}

/** Fisher–Yates: a run that runs out of time must not always starve the same tail. */
function shuffled<T>(items: T[]): T[] {
  const copy = [...items];

  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }

  return copy;
}

/**
 * One collection pass. Returns null when switched off.
 *
 * Idempotent: a key deleted by one run is simply not listed by the next, and
 * a run cut short by its budget leaves the rest for tomorrow's overlapping
 * window.
 */
async function runOrphanUploadGc({
  mode,
  now = Date.now(),
  budgetMs = RUN_BUDGET_MS,
  uploadService = new UploadService(),
}: RunOptions): Promise<OrphanGcSummary | null> {
  if (mode === "off") return null;

  const deadline = Date.now() + budgetMs;
  const window = orphanWindow(now);
  const since = new Date(window.startMs - DAY_MS);

  const summary: OrphanGcSummary = {
    mode,
    scopes: 0,
    scanned: 0,
    referenced: 0,
    orphaned: 0,
    deleted: 0,
    failed: 0,
    errors: 0,
    stoppedEarly: false,
    sample: [],
  };

  // One scope's storage or database failure costs that scope only. A
  // rejection used to end the whole run — without the summary the decision
  // to switch deleting on depends on — while the other workers kept going
  // unobserved. A scope that fails before its reference lookup answers
  // deletes nothing, so skipping it is always the safe side.
  const guarded =
    (scope: string, run: () => Promise<void>) => async (): Promise<void> => {
      try {
        await run();
      } catch (error) {
        summary.errors += 1;

        // A database that is down fails every scope; a few lines say so.
        if (summary.errors <= SAMPLE_SIZE) {
          log.error(
            { scope, err: error },
            "orphan upload scope skipped in this run",
          );
        }
      }
    };

  // Settles one scope's keys: which are referenced, and what happens to
  // the rest.
  const settle = async (
    namespace: NamespaceSpec,
    prefix: string,
    scopeId: string,
    keys: string[],
  ): Promise<void> => {
    summary.scopes += 1;
    summary.scanned += keys.length;

    if (keys.length === 0) return;

    const referenced = await namespace.referenced({
      scopeId,
      keys,
      ...keyRange(prefix, window),
      since,
    });

    const orphans = keys.filter((key) => !referenced.has(key));

    summary.referenced += keys.length - orphans.length;
    summary.orphaned += orphans.length;

    for (const key of orphans) {
      if (summary.sample.length < SAMPLE_SIZE) summary.sample.push(key);
    }

    if (mode !== "delete") return;

    for (const key of orphans) {
      if (await uploadService.tryDeleteFile(key)) summary.deleted += 1;
      else summary.failed += 1;
    }
  };

  const tasks: Array<() => Promise<void>> = [];

  const businesses = await database.business.findMany({ select: { id: true } });

  for (const [type, namespace] of Object.entries(ORPHAN_GC_NAMESPACES)) {
    if (namespace.scope === "business") {
      for (const { id } of businesses) {
        const prefix = `${type}/${id}/`;

        tasks.push(
          guarded(prefix, async () =>
            settle(
              namespace,
              prefix,
              id,
              await listWindow(uploadService, prefix, window, true),
            ),
          ),
        );
      }

      continue;
    }

    // Per-user namespace: one listing, then grouped by the owner in the key.
    tasks.push(
      guarded(`${type}/`, async () => {
        const keys = await listWindow(uploadService, `${type}/`, window, false);
        const byOwner = new Map<string, string[]>();

        for (const key of keys) {
          const owner = key.split("/")[1];
          byOwner.set(owner, [...(byOwner.get(owner) ?? []), key]);
        }

        for (const [owner, owned] of byOwner) {
          if (Date.now() > deadline) {
            summary.stoppedEarly = true;
            return;
          }

          await settle(namespace, `${type}/${owner}/`, owner, owned);
        }
      }),
    );
  }

  const queue = shuffled(tasks);

  const worker = async (): Promise<void> => {
    for (;;) {
      const task = queue.pop();

      if (!task) return;

      if (Date.now() > deadline) {
        summary.stoppedEarly = true;
        return;
      }

      await task();
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  return summary;
}

export {
  ORPHAN_GC_NAMESPACES,
  keyRange,
  keyTimestamp,
  orphanWindow,
  runOrphanUploadGc,
};
export type { OrphanGcMode, OrphanGcSummary, NamespaceSpec };
