import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";

import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * Honest HTTP on the Entregas catalogue and panel routes (decision 11.3):
 * not found → 404, conflict → 409, always with a `code`, over real HTTP and
 * Postgres.
 *
 * These answers used to be code-less 400s, and a record of ANOTHER company
 * answered 403 "não pertence à empresa informada" while a made-up id answered
 * 400: the difference told any caller which ids exist at other carriers.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fdf00-0000-7000-8000-00000000000a";
const OTHER = "018fdf00-0000-7000-8000-00000000000b";

const SHIPPER = "018fdf00-0000-7000-8000-0000000000f1";
const SECOND_SHIPPER = "018fdf00-0000-7000-8000-0000000000f2";
const OTHER_SHIPPER = "018fdf00-0000-7000-8000-0000000000f4";

const TYPE = "018fdf00-0000-7000-8000-0000000000c1";
const SECOND_TYPE = "018fdf00-0000-7000-8000-0000000000c2";
const USED_TYPE = "018fdf00-0000-7000-8000-0000000000c3";
const SYSTEM_TYPE = "018fdf00-0000-7000-8000-0000000000c4";
const OTHER_TYPE = "018fdf00-0000-7000-8000-0000000000c5";

const REASON = "018fdf00-0000-7000-8000-0000000000e1";
const SECOND_REASON = "018fdf00-0000-7000-8000-0000000000e2";
const USED_REASON = "018fdf00-0000-7000-8000-0000000000e3";
const OTHER_REASON = "018fdf00-0000-7000-8000-0000000000e4";

const DELIVERY = "018fdf00-0000-7000-8000-0000000000a1";
const DELIVERED = "018fdf00-0000-7000-8000-0000000000a2";
const OTHER_DELIVERY = "018fdf00-0000-7000-8000-0000000000a4";

const IMPORT = "018fdf00-0000-7000-8000-0000000000b1";
const OTHER_IMPORT = "018fdf00-0000-7000-8000-0000000000b4";

const DRIVER = "018fdf00-0000-7000-8000-0000000000d1";

const tokens: Record<string, string> = {};
const userIds: Record<string, string> = {};

let cnpjSeq = 0;

async function seedBusiness(id: string): Promise<void> {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua das Transportadoras",
      address_number: "1",
      cnpj: String(55666777000100 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });

  await prisma.businessEntitlement.create({
    data: { businessId: id, module: "DELIVERIES", enabled: true },
  });
}

async function seedUser(
  key: string,
  businessId: string | null,
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  extra: { driverId?: string; profileAccessId?: string } = {},
): Promise<void> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      driverId: extra.driverId ?? null,
      profileAccessId: extra.profileAccessId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  userIds[key] = id;
  tokens[key] = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );
}

const address = { city: "São Paulo", uf: "SP", street: "Rua" };

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  await prisma.driver.create({
    data: {
      id: DRIVER,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: "66655544433",
      cpf: "66655544433-cpf",
      rg: "rg",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: CARRIER,
    },
  });

  await seedUser("admin", CARRIER, "BUSINESS_ADMIN");
  await seedUser("otherAdmin", OTHER, "BUSINESS_ADMIN");
  await seedUser("driver", CARRIER, "BUSINESS_USER", { driverId: DRIVER });

  const readOnly = await prisma.profileAccess.create({
    data: { name: "Só leitura", businessId: CARRIER },
  });

  await prisma.permission.createMany({
    data: ["delivery_manage", "occurrence_manage"].map((key) => ({
      action: key,
      permissionKey: key,
      canRead: true,
      canWrite: false,
      profileAccessId: readOnly.id,
      businessId: CARRIER,
    })),
  });

  await seedUser("readOnly", CARRIER, "BUSINESS_USER", {
    profileAccessId: readOnly.id,
  });

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Atacado Sul", businessId: CARRIER },
      { id: SECOND_SHIPPER, name: "Bebidas Norte", businessId: CARRIER },
      // The same name at another carrier: uniqueness is per company.
      { id: OTHER_SHIPPER, name: "Embarcador Alheio", businessId: OTHER },
    ],
  });

  await prisma.occurrenceType.createMany({
    data: [
      { id: TYPE, name: "Avaria", businessId: CARRIER },
      { id: SECOND_TYPE, name: "Recusa", businessId: CARRIER },
      { id: USED_TYPE, name: "Destinatário ausente", businessId: CARRIER },
      {
        id: SYSTEM_TYPE,
        name: "Comprovante rejeitado",
        is_system: true,
        businessId: CARRIER,
      },
      { id: OTHER_TYPE, name: "Tipo Alheio", businessId: OTHER },
    ],
  });

  await prisma.statusChangeReason.createMany({
    data: [
      { id: REASON, name: "Cliente confirmou", businessId: CARRIER },
      { id: SECOND_REASON, name: "Cliente pediu", businessId: CARRIER },
      { id: USED_REASON, name: "Endereço corrigido", businessId: CARRIER },
      { id: OTHER_REASON, name: "Motivo Alheio", businessId: OTHER },
    ],
  });

  await prisma.delivery.createMany({
    data: [
      {
        id: DELIVERY,
        recipient_name: "Padaria Estrela",
        ...address,
        businessId: CARRIER,
        shipperId: SHIPPER,
      },
      {
        id: DELIVERED,
        recipient_name: "Mercado Central",
        ...address,
        businessId: CARRIER,
        shipperId: SHIPPER,
        status: "DELIVERED",
      },
      {
        id: OTHER_DELIVERY,
        recipient_name: "Cliente Alheio",
        ...address,
        businessId: OTHER,
        shipperId: OTHER_SHIPPER,
      },
    ],
  });

  // The type and the reason are part of the record now.
  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId: DELIVERED,
      businessId: CARRIER,
      occurrenceTypeId: USED_TYPE,
      reportedById: userIds.admin,
    },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "STATUS_CHANGE",
      status_from: "IN_TRANSIT",
      status_to: "DELIVERED",
      reasonId: USED_REASON,
      deliveryId: DELIVERED,
      businessId: CARRIER,
    } as never,
  });

  await prisma.import.createMany({
    data: [
      {
        id: IMPORT,
        source: "SPREADSHEET",
        filename: "entregas.csv",
        report: {},
        businessId: CARRIER,
        performedById: userIds.admin,
      },
      {
        id: OTHER_IMPORT,
        source: "SPREADSHEET",
        filename: "alheio.csv",
        report: {},
        businessId: OTHER,
        performedById: userIds.otherAdmin,
      },
    ],
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

function call(
  method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
  url: string,
  token: string,
  payload?: unknown,
) {
  return app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(payload !== undefined && { "content-type": "application/json" }),
    },
    ...(payload !== undefined && { payload: JSON.stringify(payload) }),
  });
}

function body(response: { body: string }): { code?: string; message?: string } {
  return JSON.parse(response.body);
}

type Case = {
  route: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  url: (id: string) => string;
  payload?: unknown;
  code: string;
  otherId: string;
};

const CASES: Case[] = [
  {
    route: "update-shipper",
    method: "PATCH",
    url: (id) => `/shipper/update-shipper/${id}/business/${CARRIER}`,
    payload: { name: "Nome Novo" },
    code: "SHIPPER_NOT_FOUND",
    otherId: OTHER_SHIPPER,
  },
  {
    route: "delete-shipper",
    method: "DELETE",
    url: (id) => `/shipper/delete-shipper/${id}/business/${CARRIER}`,
    code: "SHIPPER_NOT_FOUND",
    otherId: OTHER_SHIPPER,
  },
  {
    route: "update-occurrence-type",
    method: "PATCH",
    url: (id) =>
      `/occurrence-type/update-occurrence-type/${id}/business/${CARRIER}`,
    payload: { name: "Nome Novo" },
    code: "OCCURRENCE_TYPE_NOT_FOUND",
    otherId: OTHER_TYPE,
  },
  {
    route: "delete-occurrence-type",
    method: "DELETE",
    url: (id) =>
      `/occurrence-type/delete-occurrence-type/${id}/business/${CARRIER}`,
    code: "OCCURRENCE_TYPE_NOT_FOUND",
    otherId: OTHER_TYPE,
  },
  {
    route: "update-status-change-reason",
    method: "PATCH",
    url: (id) =>
      `/status-change-reason/update-status-change-reason/${id}/business/${CARRIER}`,
    payload: { name: "Nome Novo" },
    code: "STATUS_CHANGE_REASON_NOT_FOUND",
    otherId: OTHER_REASON,
  },
  {
    route: "delete-status-change-reason",
    method: "DELETE",
    url: (id) =>
      `/status-change-reason/delete-status-change-reason/${id}/business/${CARRIER}`,
    code: "STATUS_CHANGE_REASON_NOT_FOUND",
    otherId: OTHER_REASON,
  },
  {
    route: "get-delivery",
    method: "GET",
    url: (id) => `/delivery/get-delivery/${id}/business/${CARRIER}`,
    code: "DELIVERY_NOT_FOUND",
    otherId: OTHER_DELIVERY,
  },
  {
    route: "update-delivery",
    method: "PATCH",
    url: (id) => `/delivery/update-delivery/${id}/business/${CARRIER}`,
    payload: { recipient_name: "Outro Nome" },
    code: "DELIVERY_NOT_FOUND",
    otherId: OTHER_DELIVERY,
  },
  {
    route: "update-delivery-status",
    method: "PATCH",
    url: (id) => `/delivery/update-delivery-status/${id}/business/${CARRIER}`,
    payload: { status: "CANCELLED", reasonId: REASON },
    code: "DELIVERY_NOT_FOUND",
    otherId: OTHER_DELIVERY,
  },
  {
    route: "get-import",
    method: "GET",
    url: (id) => `/import/get-import/${id}/business/${CARRIER}`,
    code: "IMPORT_NOT_FOUND",
    otherId: OTHER_IMPORT,
  },
  {
    route: "reverse-import",
    method: "POST",
    url: (id) => `/import/reverse-import/${id}/business/${CARRIER}`,
    code: "IMPORT_NOT_FOUND",
    otherId: OTHER_IMPORT,
  },
];

describe("an id that does not exist, or is another company's (decision 11.3)", () => {
  it.each(CASES)(
    "$route answers 404 $code for a made-up id",
    async ({ method, url, payload, code }) => {
      const response = await call(
        method,
        url(randomUUID()),
        tokens.admin,
        payload,
      );

      expect(response.statusCode, response.body).toBe(404);
      expect(body(response).code).toBe(code);
      expect(response.headers["x-error-code"]).toBe(code);
    },
  );

  it.each(CASES)(
    "$route answers another company's id exactly like a missing one",
    async ({ method, url, payload, code, otherId }) => {
      const missing = await call(
        method,
        url(randomUUID()),
        tokens.admin,
        payload,
      );
      const foreign = await call(method, url(otherId), tokens.admin, payload);

      expect(foreign.statusCode, foreign.body).toBe(404);
      expect(body(foreign)).toEqual(body(missing));
      expect(body(foreign).code).toBe(code);
    },
  );

  it("left every record of the other company as it was", async () => {
    expect(
      await prisma.shipper.findUniqueOrThrow({ where: { id: OTHER_SHIPPER } }),
    ).toMatchObject({ name: "Embarcador Alheio", is_active: true });
    expect(
      await prisma.occurrenceType.findUniqueOrThrow({
        where: { id: OTHER_TYPE },
      }),
    ).toMatchObject({ name: "Tipo Alheio" });
    expect(
      await prisma.statusChangeReason.findUniqueOrThrow({
        where: { id: OTHER_REASON },
      }),
    ).toMatchObject({ name: "Motivo Alheio" });
    expect(
      await prisma.delivery.findUniqueOrThrow({
        where: { id: OTHER_DELIVERY },
      }),
    ).toMatchObject({ recipient_name: "Cliente Alheio", status: "PENDING" });
    expect(
      await prisma.import.findUniqueOrThrow({ where: { id: OTHER_IMPORT } }),
    ).toMatchObject({ status: "COMPLETED" });
  });

  it("refuses another company's shipper on a new delivery with the same 404", async () => {
    const foreign = await call(
      "POST",
      `/delivery/create-delivery/${CARRIER}`,
      tokens.admin,
      {
        recipient_name: "Cliente",
        cep: "01001000",
        ...address,
        shipperId: OTHER_SHIPPER,
      },
    );

    expect(foreign.statusCode, foreign.body).toBe(404);
    expect(body(foreign).code).toBe("SHIPPER_NOT_FOUND");

    const missing = await call(
      "POST",
      `/delivery/create-delivery/${CARRIER}`,
      tokens.admin,
      {
        recipient_name: "Cliente",
        cep: "01001000",
        ...address,
        shipperId: randomUUID(),
      },
    );

    expect(body(missing)).toEqual(body(foreign));
  });

  it("refuses another company's shipper when moving a delivery to it", async () => {
    const response = await call(
      "PATCH",
      `/delivery/update-delivery/${DELIVERY}/business/${CARRIER}`,
      tokens.admin,
      { shipperId: OTHER_SHIPPER },
    );

    expect(response.statusCode, response.body).toBe(404);
    expect(body(response).code).toBe("SHIPPER_NOT_FOUND");
  });
});

describe("a conflict is a 409 with a code (decision 11.3)", () => {
  it.each([
    {
      label: "a new shipper",
      url: `/shipper/create-shipper/${CARRIER}`,
      payload: { name: "Atacado Sul" },
      code: "SHIPPER_NAME_TAKEN",
    },
    {
      label: "a new occurrence type",
      url: `/occurrence-type/create-occurrence-type/${CARRIER}`,
      payload: { name: "Avaria" },
      code: "OCCURRENCE_TYPE_NAME_TAKEN",
    },
    {
      label: "a new reason",
      url: `/status-change-reason/create-status-change-reason/${CARRIER}`,
      payload: { name: "Cliente confirmou" },
      code: "STATUS_CHANGE_REASON_NAME_TAKEN",
    },
  ])(
    "refuses $label with a name the company already uses",
    async ({ url, payload, code }) => {
      const response = await call("POST", url, tokens.admin, payload);

      expect(response.statusCode, response.body).toBe(409);
      expect(body(response).code).toBe(code);
    },
  );

  it.each([
    {
      label: "shipper",
      url: `/shipper/update-shipper/${SECOND_SHIPPER}/business/${CARRIER}`,
      payload: { name: "Atacado Sul" },
      code: "SHIPPER_NAME_TAKEN",
    },
    {
      label: "occurrence type",
      url: `/occurrence-type/update-occurrence-type/${SECOND_TYPE}/business/${CARRIER}`,
      payload: { name: "Avaria" },
      code: "OCCURRENCE_TYPE_NAME_TAKEN",
    },
    {
      label: "reason",
      url: `/status-change-reason/update-status-change-reason/${SECOND_REASON}/business/${CARRIER}`,
      payload: { name: "Cliente confirmou" },
      code: "STATUS_CHANGE_REASON_NAME_TAKEN",
    },
  ])(
    "refuses renaming a $label to a name the company already uses",
    async ({ url, payload, code }) => {
      const response = await call("PATCH", url, tokens.admin, payload);

      expect(response.statusCode, response.body).toBe(409);
      expect(body(response).code).toBe(code);
    },
  );

  it("answers a name taken between the check and the write with the same 409", async () => {
    // The pre-check is blinded to open the window a twin request would hit;
    // the unique index that closes it is the real one.
    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );
    const { BusinessRepository } = await import(
      "@/modules/business/repositories/business-repository"
    );
    const { StatusChangeReasonRepository } = await import(
      "@/modules/status-change-reason/repositories/status-change-reason-repository"
    );
    const { CreateStatusChangeReasonUseCase } = await import(
      "@/modules/status-change-reason/usecases/create-status-change-reason/create-status-change-reason-usecase"
    );
    const { UpdateStatusChangeReasonUseCase } = await import(
      "@/modules/status-change-reason/usecases/update-status-change-reason/update-status-change-reason-usecase"
    );
    const { CreateOccurrenceTypeUseCase } = await import(
      "@/modules/occurrence-type/usecases/create-occurrence-type/create-occurrence-type-usecase"
    );
    const { UpdateOccurrenceTypeUseCase } = await import(
      "@/modules/occurrence-type/usecases/update-occurrence-type/update-occurrence-type-usecase"
    );

    class BlindReasons extends StatusChangeReasonRepository {
      async findStatusChangeReasonByName(): Promise<null> {
        return null;
      }
    }

    class BlindTypes extends OccurrenceTypeRepository {
      async findOccurrenceTypeByName(): Promise<null> {
        return null;
      }
    }

    const users = new UserRepository(prisma);
    const businesses = new BusinessRepository(prisma);
    const reasons = new BlindReasons(prisma);
    const types = new BlindTypes(prisma);

    const attempts = [
      new CreateStatusChangeReasonUseCase(users, businesses, reasons).execute(
        { name: "Cliente confirmou", businessId: CARRIER } as never,
        userIds.admin,
      ),
      new UpdateStatusChangeReasonUseCase(users, reasons).execute(
        { name: "Cliente confirmou" } as never,
        SECOND_REASON,
        CARRIER,
        userIds.admin,
      ),
      new CreateOccurrenceTypeUseCase(users, businesses, types).execute(
        { name: "Avaria", businessId: CARRIER } as never,
        userIds.admin,
      ),
      new UpdateOccurrenceTypeUseCase(users, types).execute({
        userId: userIds.admin,
        businessId: CARRIER,
        occurrenceTypeId: SECOND_TYPE,
        occurrenceTypeData: { name: "Avaria" },
      } as never),
    ];

    const codes = await Promise.all(
      attempts.map((attempt) =>
        attempt.then(
          () => "written",
          (error: { statusCode?: number; code?: string }) =>
            `${error.statusCode} ${error.code}`,
        ),
      ),
    );

    expect(codes).toEqual([
      "409 STATUS_CHANGE_REASON_NAME_TAKEN",
      "409 STATUS_CHANGE_REASON_NAME_TAKEN",
      "409 OCCURRENCE_TYPE_NAME_TAKEN",
      "409 OCCURRENCE_TYPE_NAME_TAKEN",
    ]);
  });

  it("takes a name another company uses: uniqueness is per company", async () => {
    const response = await call(
      "POST",
      `/shipper/create-shipper/${CARRIER}`,
      tokens.admin,
      {
        name: "Embarcador Alheio",
      },
    );

    expect(response.statusCode, response.body).toBe(201);
  });

  it.each([
    {
      label: "a shipper with deliveries",
      url: `/shipper/delete-shipper/${SHIPPER}/business/${CARRIER}`,
      code: "SHIPPER_HAS_DELIVERIES",
    },
    {
      label: "an occurrence type already reported",
      url: `/occurrence-type/delete-occurrence-type/${USED_TYPE}/business/${CARRIER}`,
      code: "OCCURRENCE_TYPE_IN_USE",
    },
    {
      label: "a reason already cited",
      url: `/status-change-reason/delete-status-change-reason/${USED_REASON}/business/${CARRIER}`,
      code: "STATUS_CHANGE_REASON_IN_USE",
    },
  ])(
    "refuses deleting $label, which is part of the record",
    async ({ url, code }) => {
      const response = await call("DELETE", url, tokens.admin);

      expect(response.statusCode, response.body).toBe(409);
      expect(body(response).code).toBe(code);
    },
  );

  it("refuses editing a delivery that already ended", async () => {
    const response = await call(
      "PATCH",
      `/delivery/update-delivery/${DELIVERED}/business/${CARRIER}`,
      tokens.admin,
      { recipient_name: "Outro Nome" },
    );

    expect(response.statusCode, response.body).toBe(409);
    expect(body(response).code).toBe("DELIVERY_NOT_EDITABLE");
  });
});

describe("who may write to the catalogue", () => {
  const WRITES = [
    {
      method: "PATCH" as const,
      url: `/shipper/update-shipper/${SHIPPER}/business/${CARRIER}`,
      payload: { name: "X Novo" },
    },
    {
      method: "DELETE" as const,
      url: `/shipper/delete-shipper/${SECOND_SHIPPER}/business/${CARRIER}`,
    },
    {
      method: "PATCH" as const,
      url: `/occurrence-type/update-occurrence-type/${TYPE}/business/${CARRIER}`,
      payload: { name: "X Novo" },
    },
    {
      method: "DELETE" as const,
      url: `/occurrence-type/delete-occurrence-type/${SECOND_TYPE}/business/${CARRIER}`,
    },
    {
      method: "PATCH" as const,
      url: `/status-change-reason/update-status-change-reason/${REASON}/business/${CARRIER}`,
      payload: { name: "X Novo" },
    },
    {
      method: "DELETE" as const,
      url: `/status-change-reason/delete-status-change-reason/${SECOND_REASON}/business/${CARRIER}`,
    },
  ];

  it.each(WRITES)(
    "refuses a read-only profile: $method $url",
    async ({ method, url, payload }) => {
      const response = await call(method, url, tokens.readOnly, payload);

      expect(response.statusCode).toBe(403);
      expect(body(response).code).toBe("PERMISSION_DENIED");
    },
  );

  it.each(WRITES)(
    "refuses another company's manager naming this one: $method $url",
    async ({ method, url, payload }) => {
      const response = await call(method, url, tokens.otherAdmin, payload);

      expect(response.statusCode).toBe(403);
      expect(body(response).code).toBeTruthy();
    },
  );

  it("changed nothing on the refused writes", async () => {
    expect(await prisma.shipper.count({ where: { id: SECOND_SHIPPER } })).toBe(
      1,
    );
    expect(
      await prisma.occurrenceType.count({ where: { id: SECOND_TYPE } }),
    ).toBe(1);
    expect(
      await prisma.statusChangeReason.count({ where: { id: SECOND_REASON } }),
    ).toBe(1);
    expect(
      (await prisma.shipper.findUniqueOrThrow({ where: { id: SHIPPER } })).name,
    ).toBe("Atacado Sul");
  });
});

describe("the platform's own occurrence type is not the company's to change (DLVP-OCC-3)", () => {
  it("refuses renaming, retiring and deleting it", async () => {
    for (const payload of [{ name: "Outro nome" }, { is_active: false }]) {
      const response = await call(
        "PATCH",
        `/occurrence-type/update-occurrence-type/${SYSTEM_TYPE}/business/${CARRIER}`,
        tokens.admin,
        payload,
      );

      expect(response.statusCode, response.body).toBe(409);
      expect(body(response).code).toBe("OCCURRENCE_TYPE_SYSTEM");
    }

    const deleted = await call(
      "DELETE",
      `/occurrence-type/delete-occurrence-type/${SYSTEM_TYPE}/business/${CARRIER}`,
      tokens.admin,
    );

    expect(deleted.statusCode, deleted.body).toBe(409);
    expect(body(deleted).code).toBe("OCCURRENCE_TYPE_SYSTEM");

    expect(
      await prisma.occurrenceType.findUniqueOrThrow({
        where: { id: SYSTEM_TYPE },
      }),
    ).toMatchObject({
      name: "Comprovante rejeitado",
      is_active: true,
      is_system: true,
    });
  });

  it("leaves a company type with the same name alone and takes the fallback name", async () => {
    await prisma.occurrenceType.create({
      data: { name: "Comprovante recusado", businessId: OTHER },
    });

    const repository = new OccurrenceTypeRepository(prisma);
    const data = {
      name: "Comprovante recusado",
      description: "Registrado pela auditoria de comprovantes.",
      blocks_delivery: false,
      requires_photo: false,
    };

    const first = await repository.ensureByName(OTHER, data);
    const again = await repository.ensureByName(OTHER, data);

    expect(first.name).toBe("Comprovante recusado (sistema)");
    expect(again.id).toBe(first.id);

    const rows = await prisma.occurrenceType.findMany({
      where: {
        businessId: OTHER,
        name: { startsWith: "Comprovante recusado" },
      },
      orderBy: { name: "asc" },
    });

    expect(rows.map((row) => [row.name, row.is_system])).toEqual([
      ["Comprovante recusado", false],
      ["Comprovante recusado (sistema)", true],
    ]);

    // The twin answers the same (decision 13.2).
    const twin = new InMemoryOccurrenceTypeRepository();
    const own = await twin.createOccurrenceType({
      name: "Comprovante recusado",
      businessId: OTHER,
    } as never);

    const twinFirst = await twin.ensureByName(OTHER, data);
    const twinAgain = await twin.ensureByName(OTHER, data);

    expect(twinFirst.name).toBe("Comprovante recusado (sistema)");
    expect(twinAgain.id).toBe(twinFirst.id);
    expect(twinFirst.id).not.toBe(own.id);
    expect(
      twin.occurrenceTypes.find((row) => row.id === own.id)?.is_system,
    ).toBeFalsy();
  });

  it("finds the platform's row again by its flag, not by the first free name", async () => {
    const repository = new OccurrenceTypeRepository(prisma);
    const data = {
      name: "Comprovante rejeitado",
      description: "Registrado pela auditoria de comprovantes.",
      blocks_delivery: false,
      requires_photo: false,
    };

    const found = await repository.ensureByName(CARRIER, data);

    expect(found.id).toBe(SYSTEM_TYPE);
  });
});
