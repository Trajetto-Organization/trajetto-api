import { describe, expect, it } from "vitest";

import { ExportServiceOrderUseCase } from "@/modules/service-order/usecases/export-service-order/export-service-order-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryServiceOrderRepository } from "@/modules/service-order/repositories/in-memory/in-memory-service-order-repository";

import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

/**
 * The service order file reads its dates in the company's zone (decision
 * 1.2). The shared formatters used the container's clock (UTC): an order
 * saved at 22:30 in São Paulo came out as the next day at 01:30.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
const VEHICLE = "018f0000-0000-7000-8000-0000000000e1";

/** 22:30 on 20/09 in São Paulo (UTC-3), 21:30 in Manaus (UTC-4). */
const LATE_EVENING = new Date("2026-09-21T01:30:00Z");

async function exportRow(timezone: string) {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();
  const orders = new InMemoryServiceOrderRepository();

  users.user.push({ id: USER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User);
  businesses.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: BUSINESS,
    timezone,
  } as unknown as Business);

  const order = await orders.createServiceOrder({
    date: LATE_EVENING,
    completion_date: LATE_EVENING,
    maintenance_type: "INTERNAL",
    total_amount: 100,
    businessId: BUSINESS,
    vehicleId: VEHICLE,
    responsibleUserId: USER,
    branchId: "018f0000-0000-7000-8000-0000000000b1",
    created_from: "WEB_DASHBOARD",
  } as never);

  order.created_at = LATE_EVENING;
  order.updated_at = LATE_EVENING;

  const { iterator, columns } = await new ExportServiceOrderUseCase(
    users,
    businesses,
    orders,
  ).execute(USER, {});

  const rows: Record<string, unknown>[] = [];

  for await (const row of iterator) rows.push(row);

  const cell = (header: string) => {
    const column = columns.find((entry) => entry.header === header);

    if (!column?.formatter) throw new Error(`no column ${header}`);

    return String(column.formatter(rows[0][column.key] as never, rows[0]));
  };

  return cell;
}

describe("the service order export reads dates in the company's zone", () => {
  // The old formatters followed the process clock: UTC in the container,
  // São Paulo on a developer machine (TZ cannot be switched inside a vitest
  // worker). A Manaus company differs from both, so it fails either way.
  it("prints an instant at 01:30Z as the previous evening in São Paulo", async () => {
    const cell = await exportRow("America/Sao_Paulo");

    expect(cell("Data")).toBe("20/09/2026");
    expect(cell("Data de Conclusão")).toBe("20/09/2026");
    expect(cell("Criado em")).toMatch(/^20\/09\/2026,? 22:30$/);
    expect(cell("Atualizado em")).toMatch(/^20\/09\/2026,? 22:30$/);
  });

  it("follows the company's own zone, not a fixed one", async () => {
    const cell = await exportRow("America/Manaus");

    expect(cell("Criado em")).toMatch(/^20\/09\/2026,? 21:30$/);
  });
});
