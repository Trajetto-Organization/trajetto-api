-- AlterTable
ALTER TABLE "business" ADD COLUMN     "ai_analysis_limit" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ai_analysis_reset_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "ai_analysis_used" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "fuel" ADD COLUMN     "odometer_ai_analyzed_at" TIMESTAMP(3),
ADD COLUMN     "odometer_ai_details" JSONB,
ADD COLUMN     "odometer_ai_reading" DOUBLE PRECISION,
ADD COLUMN     "odometer_ai_status" TEXT NOT NULL DEFAULT 'pending';

-- AlterTable
ALTER TABLE "vehicle_checklist" ADD COLUMN     "ai_verification_details" JSONB,
ADD COLUMN     "ai_verification_status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "ai_verified_at" TIMESTAMP(3),
ADD COLUMN     "photos_by_field" JSONB;
