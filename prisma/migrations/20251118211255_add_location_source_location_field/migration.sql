-- CreateEnum
CREATE TYPE "LocationSource" AS ENUM ('GPS_AUTO', 'GPS_MANUAL', 'USER_MANUAL', 'NONE');

-- CreateEnum
CREATE TYPE "RecordOrigin" AS ENUM ('MOBILE_APP', 'WEB_DASHBOARD');

-- AlterTable
ALTER TABLE "fine" ADD COLUMN     "created_from" "RecordOrigin" NOT NULL DEFAULT 'WEB_DASHBOARD',
ADD COLUMN     "latitude_original" DOUBLE PRECISION,
ADD COLUMN     "location_edited_at" TIMESTAMP(3),
ADD COLUMN     "location_edited_by" TEXT,
ADD COLUMN     "location_source" "LocationSource",
ADD COLUMN     "longitude_original" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "fuel" ADD COLUMN     "created_from" "RecordOrigin" NOT NULL DEFAULT 'WEB_DASHBOARD',
ADD COLUMN     "latitude_original" DOUBLE PRECISION,
ADD COLUMN     "location_edited_at" TIMESTAMP(3),
ADD COLUMN     "location_edited_by" TEXT,
ADD COLUMN     "location_source" "LocationSource",
ADD COLUMN     "longitude_original" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "service_order" ADD COLUMN     "created_from" "RecordOrigin" NOT NULL DEFAULT 'WEB_DASHBOARD',
ADD COLUMN     "latitude_original" DOUBLE PRECISION,
ADD COLUMN     "location_edited_at" TIMESTAMP(3),
ADD COLUMN     "location_edited_by" TEXT,
ADD COLUMN     "location_source" "LocationSource",
ADD COLUMN     "longitude_original" DOUBLE PRECISION;
