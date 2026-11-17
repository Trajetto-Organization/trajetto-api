/**
 * The archive's settings, apart from the storage client so the env schema
 * can check them without importing the S3 SDK or the uploads (plano-escala
 * F2-11).
 */

/** The storage classes R2 takes; the archive is written once, read rarely. */
const ARCHIVE_STORAGE_CLASSES = ["STANDARD", "STANDARD_IA"] as const;

type ArchiveStorageClass = (typeof ARCHIVE_STORAGE_CLASSES)[number];

/** What the archive storage needs from the environment. */
interface ArchiveStorageEnv {
  TRAIL_ARCHIVE_BUCKET?: string;
  ARCHIVE_R2_ACCESS_KEY_ID?: string;
  ARCHIVE_R2_SECRET_ACCESS_KEY?: string;
  ARCHIVE_STORAGE_CLASS: ArchiveStorageClass;
  R2_ACCOUNT_ID?: string;
  R2_ENDPOINT?: string;
}

/**
 * The names of what is missing for the archive storage; empty when it can
 * be built. Names only, never a value: the result goes to logs.
 */
function missingArchiveSettings(
  values: Omit<ArchiveStorageEnv, "ARCHIVE_STORAGE_CLASS">,
): string[] {
  const missing: string[] = [];

  if (!values.TRAIL_ARCHIVE_BUCKET) missing.push("TRAIL_ARCHIVE_BUCKET");
  if (!values.ARCHIVE_R2_ACCESS_KEY_ID) {
    missing.push("ARCHIVE_R2_ACCESS_KEY_ID");
  }
  if (!values.ARCHIVE_R2_SECRET_ACCESS_KEY) {
    missing.push("ARCHIVE_R2_SECRET_ACCESS_KEY");
  }
  if (!values.R2_ACCOUNT_ID && !values.R2_ENDPOINT) {
    missing.push("R2_ACCOUNT_ID");
  }

  return missing;
}

export { ARCHIVE_STORAGE_CLASSES, missingArchiveSettings };
export type { ArchiveStorageClass, ArchiveStorageEnv };
