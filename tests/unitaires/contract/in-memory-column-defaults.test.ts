import { describe, expect, it } from "vitest";

import { InMemoryAccountPayableRepository } from "@/modules/account-payable/repositories/in-memory/in-memory-account-payable-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryVehicleTypeRepository } from "@/modules/vehicle-type/repositories/in-memory/in-memory-vehicle-type-repository";

import type { CreateBusinessProps } from "@/modules/business/dtos/business-dto";
import type { CreateOccurrenceProps } from "@/modules/delivery/dtos/delivery-dto";
import type { CreateDriverProps } from "@/modules/driver/dtos/driver-dto";
import type { CreateOccurrenceTypeProps } from "@/modules/occurrence-type/dtos/occurrence-type-dto";

/**
 * The final-phase migrations gave existing tables NOT NULL columns with a
 * default (Business.timezone, the occurrence form/authorization flags). A
 * Prisma repository returns them from the first INSERT on, so the fakes must
 * too (decision 13.2) — the values are pinned to the real columns in
 * tests/E2E/schema-expand-contract.test.ts.
 *
 * The DTOs gain these fields in later packages, so the rows are read here as
 * records: the point is what the fake stores, not what the type says yet.
 */
const BUSINESS: CreateBusinessProps = {
  corporate_reason: "Transportadora Padrão",
  cep: "01001000",
  city: "São Paulo",
  uf: "SP",
  street: "Rua",
  address_number: "1",
  cnpj: "11222333000181",
  cnae: "4930202",
  responsible_name: "Responsável",
  telephone: "11999999999",
  email: "padrao@example.com",
};

const asRecord = (row: unknown): Record<string, unknown> =>
  row as Record<string, unknown>;

describe("in-memory repositories apply the columns' defaults", () => {
  it("business: the default time zone, unless one is given", async () => {
    const businesses = new InMemoryBusinessRepository();

    const created = await businesses.createBusiness(BUSINESS);
    const read = await businesses.findBusinessById(created.id!);

    expect(asRecord(read).timezone).toBe("America/Sao_Paulo");

    // An explicit value wins, as it does in SQL.
    const manaus = await businesses.createBusiness({
      ...BUSINESS,
      // Business has unique corporate reason, CNPJ and e-mail.
      corporate_reason: `${BUSINESS.corporate_reason} Manaus`,
      email: `manaus.${BUSINESS.email}`,
      cnpj: "11444777000161",
      timezone: "America/Manaus",
    } as CreateBusinessProps);

    expect(asRecord(manaus).timezone).toBe("America/Manaus");
  });

  it("occurrence type: version 1 of an empty form, no authorization, not a system type", async () => {
    const types = new InMemoryOccurrenceTypeRepository();

    const created = await types.createOccurrenceType({
      businessId: "business-defaults",
      name: "Avaria",
    });
    const read = await types.findOccurrenceTypeById(created.id!);

    expect(asRecord(read)).toMatchObject({
      form_version: 1,
      requires_authorization: false,
      is_system: false,
    });

    const guarded = await types.createOccurrenceType({
      businessId: "business-defaults",
      name: "Devolução",
      requires_authorization: true,
    } as CreateOccurrenceTypeProps);

    expect(asRecord(guarded).requires_authorization).toBe(true);

    // The proof audit's type goes through the same create.
    const system = await types.ensureByName("business-defaults", {
      name: "Comprovante rejeitado",
      description: "Criado pela auditoria de comprovantes.",
      blocks_delivery: false,
      requires_photo: false,
    });

    expect(asRecord(await types.findOccurrenceTypeById(system.id))).toMatchObject({
      form_version: 1,
      requires_authorization: false,
    });
  });

  it("delivery occurrence: NOT_REQUIRED authorization", async () => {
    const deliveries = new InMemoryDeliveryRepository();
    // createOccurrence copies the delivery's tenant (findUniqueOrThrow).
    deliveries.deliveries.push({
      id: "delivery-1",
      businessId: "business-defaults",
      shipperId: "shipper-1",
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "PENDING",
    });

    await deliveries.createOccurrence({
      deliveryId: "delivery-1",
      occurrenceTypeId: "type-1",
      reportedById: "user-1",
    });

    expect(asRecord(deliveries.occurrences[0]).authorization_status).toBe(
      "NOT_REQUIRED",
    );
  });

  it("an undefined value is 'not given', as Prisma reads it: the default still applies", async () => {
    // Use cases build payloads with keys that may be undefined
    // (`authorization_status: needsAuth ? "PENDING" : undefined`). Prisma
    // leaves such a key out and the column default applies; the fake must not
    // store undefined instead.
    const businesses = new InMemoryBusinessRepository();
    const business = await businesses.createBusiness({
      ...BUSINESS,
      timezone: undefined,
    } as CreateBusinessProps);

    expect(asRecord(business).timezone).toBe("America/Sao_Paulo");

    const types = new InMemoryOccurrenceTypeRepository();
    const type = await types.createOccurrenceType({
      businessId: "business-defaults",
      name: "Recusa",
      requires_photo: undefined,
      blocks_delivery: undefined,
      requires_authorization: undefined,
      form_version: undefined,
    } as CreateOccurrenceTypeProps);

    expect(asRecord(type)).toMatchObject({
      requires_photo: false,
      blocks_delivery: false,
      requires_authorization: false,
      form_version: 1,
    });

    const deliveries = new InMemoryDeliveryRepository();
    // createOccurrence copies the delivery's tenant (findUniqueOrThrow).
    deliveries.deliveries.push({
      id: "delivery-1",
      businessId: "business-defaults",
      shipperId: "shipper-1",
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "PENDING",
    });
    await deliveries.createOccurrence({
      deliveryId: "delivery-1",
      occurrenceTypeId: "type-1",
      reportedById: "user-1",
      authorization_status: undefined,
    } as CreateOccurrenceProps);

    expect(asRecord(deliveries.occurrences[0]).authorization_status).toBe(
      "NOT_REQUIRED",
    );
  });
});

/**
 * The nullable columns the final-phase migrations added. A Prisma read of the
 * full row returns them as null from the first INSERT on; a fake that leaves
 * them out returns undefined, and `row.authorizedById === null` is true in one
 * and false in the other. The list is pinned to the real columns in
 * tests/E2E/schema-expand-contract.test.ts.
 */
describe("in-memory repositories return null for the new nullable columns", () => {
  it("delivery, its events and its occurrences", async () => {
    const deliveries = new InMemoryDeliveryRepository();

    const delivery = await deliveries.createDelivery({
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      businessId: "business-nulls",
      shipperId: "shipper-1",
    });
    await deliveries.createDeliveryEvent({
      type: "NOTE",
      deliveryId: delivery.id!,
      reportedById: "user-1",
    });
    await deliveries.createOccurrence({
      deliveryId: delivery.id!,
      occurrenceTypeId: "type-1",
      reportedById: "user-1",
    });

    expect(asRecord(delivery)).toMatchObject({ apiKeyId: null });
    expect(asRecord(deliveries.events[0])).toMatchObject({ occurrenceId: null });
    expect(asRecord(deliveries.occurrences[0])).toMatchObject({
      form_answers: null,
      form_version: null,
      authorizedById: null,
      authorized_at: null,
      authorization_note: null,
      escalated_at: null,
    });

    // An explicit value still wins.
    await deliveries.createDeliveryEvent({
      type: "OCCURRENCE",
      deliveryId: delivery.id!,
      occurrenceId: "occurrence-1",
    } as never);

    expect(asRecord(deliveries.events[1]).occurrenceId).toBe("occurrence-1");
  });

  it("occurrence type: no form yet", async () => {
    const types = new InMemoryOccurrenceTypeRepository();

    const created = await types.createOccurrenceType({
      businessId: "business-nulls",
      name: "Avaria",
    });

    expect(asRecord(created)).toMatchObject({ form_fields: null });
  });

  it("route and its stops", async () => {
    // The stops point at real deliveries of the company (foreign key + mirror).
    const routes = new InMemoryRouteRepository([
      { id: "delivery-1", businessId: "business-nulls", status: "PENDING" },
      { id: "delivery-2", businessId: "business-nulls", status: "PENDING" },
    ]);

    const route = await routes.createRoute({
      businessId: "business-nulls",
      driverId: "driver-1",
      scheduled_date: new Date("2026-09-17T00:00:00.000Z"),
      deliveryIds: ["delivery-1"],
    });
    const {
      stops: [added],
    } = await routes.addStops(route.id, "business-nulls", ["delivery-2"]);

    expect(asRecord(route)).toMatchObject({ destination: null });
    expect(asRecord(routes.stops[0])).toMatchObject({ on_the_way_at: null });
    expect(asRecord(added)).toMatchObject({ on_the_way_at: null });
  });

  it("chat message: no route", async () => {
    const chat = new InMemoryChatRepository();
    // A message needs its thread, as the foreign key demands in Postgres.
    const thread = await chat.getOrCreateThread("business-1", "driver-1");

    const message = await chat.createMessage({
      threadId: thread.id,
      senderId: "user-1",
      kind: "TEXT",
      body: "Olá",
      attachment_key: null,
      duration_ms: null,
      deliveryId: null,
      broadcast_id: null,
      client_submission_id: null,
    });

    expect(asRecord(message)).toMatchObject({ routeId: null });
  });

  it("fleet: account payable, driver and vehicle type", async () => {
    const payables = new InMemoryAccountPayableRepository();
    const payable = await payables.createAccountPayable({
      due_date: new Date("2026-10-01T00:00:00.000Z"),
      amount: 100,
      category: "OTHER",
      businessId: "business-nulls",
      branchId: "branch-1",
      registrationUserId: "user-1",
    } as never);

    expect(asRecord(payable)).toMatchObject({
      supplierId: null,
      vehicleId: null,
      payee_name: null,
      description: null,
      document_number: null,
      createdById: null,
    });

    const drivers = new InMemoryDriverRepository();
    const driver = await drivers.createDriver({
      name: "Motorista",
      cnh: "12345678901",
      cpf: "52998224725",
      businessId: "business-nulls",
    } as CreateDriverProps);

    expect(asRecord(driver)).toMatchObject({
      cnh_category: null,
      cnh_expires_at: null,
    });

    const vehicleTypes = new InMemoryVehicleTypeRepository();
    const vehicleType = await vehicleTypes.createVehicleType({
      description: "Toco",
      number_of_axles: 2,
      businessId: "business-nulls",
    });

    expect(asRecord(vehicleType)).toMatchObject({ required_cnh_category: null });
  });
});
