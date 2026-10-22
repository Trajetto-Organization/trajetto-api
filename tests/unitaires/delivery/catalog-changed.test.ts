import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateShipperUseCase } from "@/modules/shipper/usecases/create-shipper/create-shipper-usecase";
import { UpdateShipperUseCase } from "@/modules/shipper/usecases/update-shipper/update-shipper-usecase";
import { DeleteShipperUseCase } from "@/modules/shipper/usecases/delete-shipper/delete-shipper-usecase";

import { CreateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/create-occurrence-type/create-occurrence-type-usecase";
import { UpdateOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/update-occurrence-type/update-occurrence-type-usecase";
import { DeleteOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/delete-occurrence-type/delete-occurrence-type-usecase";

import { CreateStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/create-status-change-reason/create-status-change-reason-usecase";
import { UpdateStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/update-status-change-reason/update-status-change-reason-usecase";
import { DeleteStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/delete-status-change-reason/delete-status-change-reason-usecase";

import { SaveMessageTemplateUseCase } from "@/modules/delivery/usecases/save-message-template/save-message-template-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";
import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";

import { saveDeliveryMessageTemplateSchema } from "@/schemas/delivery-message-template-schema";
import { createShipperSchema } from "@/schemas/create-shipper-schema";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

const catalogChanged = vi.hoisted(() => vi.fn());

vi.mock("@/websocket", () => ({ sendCatalogChangedEvent: catalogChanged }));

/**
 * Decision 2.3: a catalog change reaches every open screen of the company.
 *
 * The screen of the person who saved refetched on its own; a second
 * dispatcher (or the MASTER in /admin) kept offering a deactivated shipper
 * or missing a new occurrence type until F5. The hint goes out AFTER the
 * write, and only when there was one.
 */
const BUSINESS = "018f0000-0000-7000-8000-000000000ab1";
const ADMIN = "018f0000-0000-7000-8000-000000000aa1";

let users: InMemoryUserRepository;
let businesses: InMemoryBusinessRepository;
let shippers: InMemoryShipperRepository;
let types: InMemoryOccurrenceTypeRepository;
let reasons: InMemoryStatusChangeReasonRepository;
let templates: InMemoryDeliveryMessageTemplateRepository;

beforeEach(() => {
  catalogChanged.mockReset();

  users = new InMemoryUserRepository();
  businesses = new InMemoryBusinessRepository();
  shippers = new InMemoryShipperRepository();
  types = new InMemoryOccurrenceTypeRepository();
  reasons = new InMemoryStatusChangeReasonRepository();
  templates = new InMemoryDeliveryMessageTemplateRepository();

  users.user.push({
    id: ADMIN,
    name: "Gestora",
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  businesses.business.push({ id: BUSINESS } as Business);
});

describe("shippers", () => {
  it("announces create, update and delete, each after the write", async () => {
    const created = await new CreateShipperUseCase(
      users,
      businesses,
      shippers,
    ).execute({ name: "Embarcador Norte", businessId: BUSINESS }, ADMIN);

    expect(catalogChanged).toHaveBeenLastCalledWith(BUSINESS, "shipper");

    await new UpdateShipperUseCase(users, shippers).execute({
      userId: ADMIN,
      businessId: BUSINESS,
      shipperId: created.id!,
      shipperData: { is_active: false },
    });

    expect(catalogChanged).toHaveBeenCalledTimes(2);

    await new DeleteShipperUseCase(users, shippers).execute({
      userId: ADMIN,
      businessId: BUSINESS,
      shipperId: created.id!,
    });

    expect(catalogChanged).toHaveBeenCalledTimes(3);
    expect(shippers.shippers).toEqual([]);
  });

  it("announces nothing when the write is refused", async () => {
    const useCase = new CreateShipperUseCase(users, businesses, shippers);

    await useCase.execute(
      { name: "Embarcador Norte", businessId: BUSINESS },
      ADMIN,
    );
    catalogChanged.mockReset();

    await expect(
      useCase.execute(
        { name: "Embarcador Norte", businessId: BUSINESS },
        ADMIN,
      ),
    ).rejects.toThrow("Já existe um embarcador com este nome");

    expect(catalogChanged).not.toHaveBeenCalled();
  });

  it("refuses a second shipper with the same CNPJ in the company (decision 5.7)", async () => {
    const useCase = new CreateShipperUseCase(users, businesses, shippers);

    await useCase.execute(
      { name: "Matriz", cnpj: "11222333000181", businessId: BUSINESS },
      ADMIN,
    );

    await expect(
      useCase.execute(
        { name: "Filial", cnpj: "11222333000181", businessId: BUSINESS },
        ADMIN,
      ),
    ).rejects.toMatchObject({ statusCode: 409, code: "SHIPPER_CNPJ_TAKEN" });
  });

  it("validates the CNPJ check digits", () => {
    expect(
      createShipperSchema.safeParse({
        name: "Matriz",
        cnpj: "11.222.333/0001-81",
      }).success,
    ).toBe(true);

    const wrong = createShipperSchema.safeParse({
      name: "Matriz",
      cnpj: "11.222.333/0001-82",
    });

    expect(wrong.success).toBe(false);

    if (!wrong.success) {
      expect(wrong.error.issues[0].message).toBe(
        "O CNPJ informado não é válido.",
      );
    }

    expect(
      createShipperSchema.safeParse({ name: "Matriz", cnpj: "00000000000000" })
        .success,
    ).toBe(false);
  });
});

describe("occurrence types", () => {
  it("announces create, update and delete", async () => {
    const created = await new CreateOccurrenceTypeUseCase(
      users,
      businesses,
      types,
    ).execute({ name: "Cliente ausente", businessId: BUSINESS }, ADMIN);

    await new UpdateOccurrenceTypeUseCase(users, types).execute({
      userId: ADMIN,
      businessId: BUSINESS,
      occurrenceTypeId: created.id!,
      occurrenceTypeData: { description: "Ninguém atendeu" },
    });

    await new DeleteOccurrenceTypeUseCase(users, types).execute({
      userId: ADMIN,
      businessId: BUSINESS,
      occurrenceTypeId: created.id!,
    });

    expect(catalogChanged.mock.calls).toEqual([
      [BUSINESS, "occurrence_type"],
      [BUSINESS, "occurrence_type"],
      [BUSINESS, "occurrence_type"],
    ]);
  });
});

describe("status change reasons", () => {
  it("announces create, update and delete", async () => {
    const created = await new CreateStatusChangeReasonUseCase(
      users,
      businesses,
      reasons,
    ).execute({ name: "Cliente pediu", businessId: BUSINESS }, ADMIN);

    await new UpdateStatusChangeReasonUseCase(users, reasons).execute(
      { is_active: false },
      created.id!,
      BUSINESS,
      ADMIN,
    );

    await new DeleteStatusChangeReasonUseCase(users, reasons).execute(
      created.id!,
      BUSINESS,
      ADMIN,
    );

    expect(catalogChanged.mock.calls).toEqual([
      [BUSINESS, "status_reason"],
      [BUSINESS, "status_reason"],
      [BUSINESS, "status_reason"],
    ]);
  });
});

describe("message templates", () => {
  it("announces a save", async () => {
    await new SaveMessageTemplateUseCase(users, templates).execute({
      userId: ADMIN,
      businessId: BUSINESS,
      topic: "DELIVERED",
      channel: "EMAIL",
      subject: null,
      body: "Sua entrega chegou, {{destinatario}}.",
      is_active: true,
    });

    expect(catalogChanged).toHaveBeenCalledWith(BUSINESS, "message_template");
  });

  it("refuses an unknown variable in the schema, spaces inside the braces included", () => {
    const parsed = saveDeliveryMessageTemplateSchema.safeParse({
      topic: "DELIVERED",
      channel: "EMAIL",
      body: "Olá {{ gabriel }}, sua entrega chegou.",
    });

    expect(parsed.success).toBe(false);

    if (!parsed.success) {
      expect(parsed.error.issues[0].path).toEqual(["body"]);
      expect(parsed.error.issues[0].message).toContain(
        "A mensagem usa variáveis que não existem: {{gabriel}}.",
      );
      expect(parsed.error.issues[0].message).toContain("{{destinatario}}");
    }
  });

  it("refuses the same in the subject, and a body made of spaces", () => {
    expect(
      saveDeliveryMessageTemplateSchema.safeParse({
        topic: "DELIVERED",
        channel: "EMAIL",
        subject: "Oi {{motorista}}",
        body: "Sua entrega chegou, {{destinatario}}.",
      }).success,
    ).toBe(false);

    expect(
      saveDeliveryMessageTemplateSchema.safeParse({
        topic: "DELIVERED",
        channel: "EMAIL",
        body: "            ",
      }).success,
    ).toBe(false);

    expect(
      saveDeliveryMessageTemplateSchema.safeParse({
        topic: "DELIVERED",
        channel: "EMAIL",
        subject: " Entrega",
        body: "Sua entrega chegou, {{destinatario}}.",
      }).success,
    ).toBe(false);
  });

  it("accepts the published variables with spaces inside the braces", () => {
    expect(
      saveDeliveryMessageTemplateSchema.safeParse({
        topic: "DELIVERED",
        channel: "EMAIL",
        subject: "Entrega {{ nota }}",
        body: "Olá {{ destinatario }}, previsão {{previsao}}.",
      }).success,
    ).toBe(true);
  });
});
