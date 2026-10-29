-- Entitlements: sellable modules per company. FLEET is seeded for every
-- existing business — it is the product they already bought; deploying this
-- must not lock anyone out.

-- CreateEnum
CREATE TYPE "BusinessModule" AS ENUM ('FLEET', 'DELIVERIES');

-- CreateTable
CREATE TABLE "business_entitlement" (
    "id" TEXT NOT NULL,
    "businessId" TEXT NOT NULL,
    "module" "BusinessModule" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_entitlement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "business_entitlement_businessId_module_key" ON "business_entitlement"("businessId", "module");

-- AddForeignKey
ALTER TABLE "business_entitlement" ADD CONSTRAINT "business_entitlement_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "business"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed: every existing company keeps what it already uses.
INSERT INTO "business_entitlement" ("id", "businessId", "module", "enabled", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", 'FLEET', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "business";
