import type { PrismaClient } from "@prisma/client";

import type { UploadType } from "@/config/upload";
import type { StorageDeleteOutcome } from "@/shared/services/upload-service";

/**
 * A company's objects in the uploads bucket, for its purge (plano-escala
 * F3-26b): listed a page at a time under each prefix the company owns and
 * deleted one by one, the job's cursor written after every page.
 *
 * Where a company's objects live (upload-service.ts, generatePresignedKey
 * and the server's own writes):
 *
 *  - `<type>/<businessId>/…` for the photos, the chat's attachments and
 *    the stored spreadsheets: one prefix per namespace;
 *  - `avatars/<userId>/…`: an avatar belongs to a person, so one prefix per
 *    user of the company, read before the users are deleted;
 *  - `deliveryProofs/<deliveryId>/…`: one prefix per delivery that has a
 *    proof document, read before the deliveries are deleted. Every version
 *    of a receipt sits under it, the ones no row points at included.
 *
 * A delete the bucket's lock refuses (infra/r2/bucket-locks.md: the proofs
 * are kept by the legal term) is not a failure: the object is "retained",
 * counted, and the job goes on; it leaves when its lock ends, by the
 * prefix's own Expiration rule. Any other failure fails the page, and the
 * job's retry resumes from the last page written (a delete of an object
 * already gone succeeds). The listing moves past every key it saw, so a
 * retained object is never listed again in the same purge.
 *
 * Keys in the legacy shapes outside these prefixes (before the presigned
 * uploads, ADR 0006) are not found here: nothing lists them by company.
 */

/** The storage the purge needs: UploadService's listing and delete. */
interface PurgeObjectStorage {
  listObjectKeys(
    prefix: string,
    startAfter?: string,
    maxKeys?: number,
  ): Promise<string[]>;
  deleteFileOutcome(key: string): Promise<StorageDeleteOutcome>;
}

type StorageSource =
  /** `<type>/<businessId>/`. */
  | { scope: "business"; type: UploadType }
  /** `<type>/<userId>/` for every user of the company. */
  | { scope: "user"; type: UploadType }
  /** `<type>/<deliveryId>/` for every delivery with a proof document. */
  | { scope: "delivery"; type: UploadType };

/**
 * Every namespace of UPLOAD_TYPES and how its keys name their owner;
 * tests/unitaires/jobs/r2-purge.test.ts fails when a new namespace is
 * missing here.
 */
const TENANT_STORAGE_SOURCES: readonly StorageSource[] = [
  { scope: "business", type: "odometerPhotos" },
  { scope: "business", type: "checklistPhotos" },
  { scope: "business", type: "deliveryPhotos" },
  { scope: "business", type: "chatAttachments" },
  { scope: "business", type: "spreadsheetImports" },
  { scope: "user", type: "avatars" },
  { scope: "delivery", type: "deliveryProofs" },
];

/** Keys per listing, the bucket's own page. */
const STORAGE_PAGE_SIZE = 1_000;

/** Deletes in flight at once. */
const STORAGE_DELETES_IN_FLIGHT = 8;

/** Owners (users, deliveries) read per query. */
const STORAGE_OWNERS_PER_PAGE = 100;

/** Where the purge of the bucket stands: the job's cursor. */
interface StorageCursor {
  /** The source of TENANT_STORAGE_SOURCES being listed. */
  source: number;

  /** The owners of the source still to list, the current one first. */
  owners: string[];

  /** The last owner read, where the next page of owners starts. */
  lastOwner: string;

  /** The last key listed under the current owner's prefix. */
  after: string;

  deleted: number;
  retained: number;
}

function freshStorageCursor(): StorageCursor {
  return {
    source: 0,
    owners: [],
    lastOwner: "",
    after: "",
    deleted: 0,
    retained: 0,
  };
}

interface StoragePurgeDeps {
  db: Pick<PrismaClient, "$queryRaw">;
  storage: PurgeObjectStorage;
  pageSize?: number;
}

/** The next owners of a source's prefixes, after `after`. */
async function nextOwners(
  deps: StoragePurgeDeps,
  source: StorageSource,
  businessId: string,
  after: string,
): Promise<string[]> {
  if (source.scope === "user") {
    const rows = await deps.db.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "user"
      WHERE "businessId" = ${businessId} AND "id" > ${after}
      ORDER BY "id"
      LIMIT ${STORAGE_OWNERS_PER_PAGE}
    `;

    return rows.map((row) => row.id);
  }

  // The company's deliveries by its (businessId, id) index, those with a
  // proof document only: a listing per delivery without one would be a
  // call to the bucket for nothing.
  const rows = await deps.db.$queryRaw<Array<{ id: string }>>`
    SELECT d."id" FROM "delivery" d
    WHERE d."businessId" = ${businessId} AND d."id" > ${after}
      AND EXISTS (
        SELECT 1 FROM "delivery_proof_document" p WHERE p."deliveryId" = d."id"
      )
    ORDER BY d."id"
    LIMIT ${STORAGE_OWNERS_PER_PAGE}
  `;

  return rows.map((row) => row.id);
}

/** Deletes `keys`, a few at a time; answers what the bucket said. */
async function deleteKeys(
  storage: PurgeObjectStorage,
  keys: readonly string[],
): Promise<{ deleted: number; retained: number; failed: string[] }> {
  const outcome = { deleted: 0, retained: 0, failed: [] as string[] };

  for (let start = 0; start < keys.length; start += STORAGE_DELETES_IN_FLIGHT) {
    const slice = keys.slice(start, start + STORAGE_DELETES_IN_FLIGHT);
    const results = await Promise.all(
      slice.map((key) => storage.deleteFileOutcome(key)),
    );

    results.forEach((result, index) => {
      if (result === "deleted") outcome.deleted += 1;
      else if (result === "locked") outcome.retained += 1;
      else outcome.failed.push(slice[index]);
    });
  }

  return outcome;
}

/**
 * One step of the purge of the bucket: the next page of keys under the
 * current prefix, or the next owners of the source. Answers the cursor
 * after it, or null when every source is done.
 */
async function purgeStoragePage(
  deps: StoragePurgeDeps,
  businessId: string,
  cursor: StorageCursor,
): Promise<StorageCursor | null> {
  if (cursor.source >= TENANT_STORAGE_SOURCES.length) return null;

  const source = TENANT_STORAGE_SOURCES[cursor.source];
  const nextSource = (): StorageCursor => ({
    ...cursor,
    source: cursor.source + 1,
    owners: [],
    lastOwner: "",
    after: "",
  });

  let owner: string;

  if (source.scope === "business") {
    owner = businessId;
  } else if (cursor.owners.length > 0) {
    owner = cursor.owners[0];
  } else {
    const owners = await nextOwners(deps, source, businessId, cursor.lastOwner);

    if (owners.length === 0) return nextSource();

    return {
      ...cursor,
      owners,
      lastOwner: owners[owners.length - 1],
      after: "",
    };
  }

  const prefix = `${source.type}/${owner}/`;
  const pageSize = deps.pageSize ?? STORAGE_PAGE_SIZE;
  const keys = (
    await deps.storage.listObjectKeys(
      prefix,
      cursor.after || undefined,
      pageSize,
    )
  ).filter((key) => key.startsWith(prefix));
  const outcome = await deleteKeys(deps.storage, keys);

  if (outcome.failed.length > 0) {
    throw new Error(
      `expurgo: ${outcome.failed.length} objeto(s) não puderam ser apagados em ${prefix}`,
    );
  }

  const counted = {
    deleted: cursor.deleted + outcome.deleted,
    retained: cursor.retained + outcome.retained,
  };

  // A full page may have more after it; a short one ends the prefix.
  if (keys.length >= pageSize) {
    return { ...cursor, ...counted, after: keys[keys.length - 1] };
  }

  if (source.scope === "business") return { ...nextSource(), ...counted };

  return { ...cursor, ...counted, owners: cursor.owners.slice(1), after: "" };
}

export {
  STORAGE_PAGE_SIZE,
  TENANT_STORAGE_SOURCES,
  freshStorageCursor,
  purgeStoragePage,
};
export type { PurgeObjectStorage, StorageCursor, StoragePurgeDeps };
