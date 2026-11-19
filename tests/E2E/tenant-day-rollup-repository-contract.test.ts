import { afterAll, beforeAll, describe } from "vitest";

import { createPrismaClient } from "@/shared/database/database-client";
import { InMemoryTenantDayRollupRepository } from "@/shared/rollup/in-memory-tenant-day-rollup-repository";
import { TenantDayRollupRepository } from "@/shared/rollup/tenant-day-rollup-repository";

import {
  COMPANIES,
  GHOST,
  tenantDayRollupContract,
  type TenantDayRollupHarness,
} from "../contract/repositories/tenant-day-rollup.contract";
import { KINDS, type Kind } from "../contract/support";
import { seedBusiness, seedShipper } from "../contract/seed";

/**
 * Plano-escala F4-21: the rollup's repository against Postgres (the counts,
 * the marks taken under SKIP LOCKED, the pending days in tenant_day_count)
 * and against the twin the job's unit tests run on.
 */
const prisma = createPrismaClient();
const memory = new InMemoryTenantDayRollupRepository();

const shippers = new Map<string, string>();

type Row = { metric: string; day: string; value: number };

function sorted(rows: Row[]): Row[] {
  return rows.sort((a, b) =>
    a.metric !== b.metric
      ? a.metric < b.metric
        ? -1
        : 1
      : a.day < b.day
        ? -1
        : a.day > b.day
          ? 1
          : 0,
  );
}

const harnesses: Record<Kind, () => TenantDayRollupHarness> = {
  prisma: () => ({
    kind: "prisma",
    repo: new TenantDayRollupRepository(prisma),
    async reset() {
      // The deliveries first: each DELETE marks its day (F4-20).
      await prisma.delivery.deleteMany({
        where: { businessId: { in: [...COMPANIES] } },
      });
      await prisma.tenantDayDirty.deleteMany({
        where: { businessId: { in: [...COMPANIES, GHOST] } },
      });
      await prisma.tenantDayCount.deleteMany({
        where: { businessId: { in: [...COMPANIES] } },
      });
    },
    async setBusiness(id, { timezone, purgeState }) {
      await prisma.business.update({
        where: { id },
        data: { timezone, purge_state: purgeState },
      });
    },
    async seedDelivery(businessId, createdAt) {
      await prisma.delivery.create({
        data: {
          recipient_name: "Cliente",
          city: "São Paulo",
          uf: "SP",
          street: "Rua das Entregas",
          businessId,
          shipperId: shippers.get(businessId) as string,
          created_at: createdAt,
        },
      });
    },
    async insertMark(businessId, day) {
      await prisma.tenantDayDirty.create({
        data: { businessId, day: new Date(`${day}T00:00:00.000Z`) },
      });
    },
    async marks() {
      const rows = await prisma.tenantDayDirty.findMany({
        orderBy: { id: "asc" },
      });

      return rows.map((row) => ({
        businessId: row.businessId,
        day: row.day.toISOString().slice(0, 10),
      }));
    },
    async rows(businessId) {
      const rows = await prisma.tenantDayCount.findMany({
        where: { businessId },
      });

      return sorted(
        rows.map((row) => ({
          metric: row.metric,
          day: row.day.toISOString().slice(0, 10),
          value: Number(row.value),
        })),
      );
    },
  }),
  "in-memory": () => ({
    kind: "in-memory",
    repo: memory,
    async reset() {
      memory.deliveries = [];
      memory.marks = [];
      memory.days.clear();
    },
    async setBusiness(id, { timezone, purgeState }) {
      memory.businesses.set(id, { timezone, purgeState });
    },
    async seedDelivery(businessId, createdAt) {
      memory.deliveries.push({ businessId, created_at: createdAt });
    },
    async insertMark(businessId, day) {
      memory.insertMark(businessId, day);
    },
    async marks() {
      return memory.marks.map(({ businessId, day }) => ({ businessId, day }));
    },
    async rows(businessId) {
      return sorted(
        [...memory.days.values()]
          .filter((row) => row.businessId === businessId)
          .map(({ metric, day, value }) => ({ metric, day, value })),
      );
    },
  }),
};

beforeAll(async () => {
  for (const [index, id] of COMPANIES.entries()) {
    await seedBusiness(prisma, id, 610 + index);

    const shipper = await seedShipper(prisma, id, `Embarcador ${index}`);

    shippers.set(id, shipper.id);
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.each(KINDS)("tenant day rollup repository (%s)", (kind) => {
  tenantDayRollupContract(harnesses[kind]);
});
