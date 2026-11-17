-- ----------------------------------------------------------------------------
-- archive_manifest and archive_partition: the trail's archive (plano-escala
-- F2-11)
-- ----------------------------------------------------------------------------
-- The GPS trail keeps fewer days in the database once the archive is on
-- (decision D3: 30 hot, 180 archived). Before the nightly partition job
-- drops a day, it copies the day to the archive bucket in R2, one gzipped
-- CSV per company (trail/<yyyymmdd>/<businessId>.csv.gz), and writes one
-- row per object here: its key, its row count, its size and the sha256 of
-- its bytes. The row is written PENDING before the upload starts, so a
-- crash never leaves an object nobody knows about, and the unique
-- (partition_name, businessId) makes a rerun rewrite the same object.
-- SKIPPED counts the rows of a company that no longer exists: they are
-- left out on purpose, and its archive is deleted with it.
--
-- archive_partition records a day whose manifest added up to its count,
-- taken after the uploads. Only such a day is detached and dropped; one
-- that does not add up stays in the database (the partition-stuck alert
-- counts it).
--
-- No foreign keys: a row must outlive its company (so the company's exit
-- can still find its objects) and the partition it describes. Both are
-- purged a week after the bucket's Expiration removed the objects.
--
-- Expand only: a new type and two new, empty tables. The previous image
-- never reads them, and the job writes them only with
-- TRAIL_ARCHIVE_ENABLED=true. A rollback leaves them in place, unread.
-- ----------------------------------------------------------------------------

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ArchiveObjectStatus" AS ENUM ('PENDING', 'ARCHIVED', 'SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "archive_manifest" (
    "id" TEXT NOT NULL,
    "source_table" TEXT NOT NULL,
    "partition_name" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "object_key" TEXT NOT NULL,
    "status" "ArchiveObjectStatus" NOT NULL DEFAULT 'PENDING',
    "row_count" INTEGER,
    "byte_size" BIGINT,
    "sha256" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMP(3),

    CONSTRAINT "archive_manifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "archive_partition" (
    "partition_name" TEXT NOT NULL,
    "source_table" TEXT NOT NULL,
    "row_count" BIGINT NOT NULL,
    "objects" INTEGER NOT NULL,
    "verified_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "archive_partition_pkey" PRIMARY KEY ("partition_name")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "archive_manifest_partition_name_businessId_key" ON "archive_manifest"("partition_name", "businessId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "archive_manifest_businessId_idx" ON "archive_manifest"("businessId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "archive_manifest_created_at_idx" ON "archive_manifest"("created_at");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "archive_partition_verified_at_idx" ON "archive_partition"("verified_at");
