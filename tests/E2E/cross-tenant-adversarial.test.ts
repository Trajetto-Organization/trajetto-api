import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * Uma empresa tentando alcançar a outra, rota por rota.
 *
 * Este arquivo existe porque uma auditoria adversarial encontrou SEIS rotas em
 * que o id do registro nunca era amarrado de volta ao tenant de quem chamava —
 * e a suíte inteira, 917 testes, passava igual antes e depois das correções.
 * Nenhum daqueles furos tinha teste, e é por isso que eles existiam.
 *
 * O padrão da casa é que o id não é controle de acesso: ele viaja em
 * exportação, em print, em chamado de suporte e em integração com ERP. Então
 * saber o id de outra empresa é premissa, não exploit — o que cada teste aqui
 * prova é que saber não basta.
 *
 * E a resposta é sempre 404, nunca 403: um 403 distinto confirmaria que o
 * registro existe, que é metade do que alguém varrendo ids quer saber.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = "018fc000-0000-7000-8000-00000000000a";
const B = "018fc000-0000-7000-8000-00000000000b";

const USER_A = "018fc000-0000-7000-8000-0000000000a1";
const DRIVER_USER_A = "018fc000-0000-7000-8000-0000000000a2";

const DRIVER_A = "018fc000-0000-7000-8000-0000000000d1";
const DRIVER_A2 = "018fc000-0000-7000-8000-0000000000d3";
const DRIVER_B = "018fc000-0000-7000-8000-0000000000d2";

let tokenA: string;
let driverTokenA: string;

const created: { fineB?: string; partB?: string; vehicleB?: string } = {};

let fuelTypeB = "";
let supplierB = "";

async function seedBusiness(id: string, cnpj: string): Promise<void> {
  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj,
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `adv-${id}-${randomUUID()}@exemplo.com.br`,
    },
  });

  // Os DOIS módulos. Sem FLEET, as rotas de peça, abastecimento e multa
  // respondem 403 MODULE_NOT_ENABLED antes de chegar na regra de tenant — e o
  // teste passaria provando que o entitlement funciona, não o isolamento.
  await prisma.businessEntitlement.createMany({
    data: [
      { businessId: id, module: "DELIVERIES", enabled: true },
      { businessId: id, module: "FLEET", enabled: true },
    ],
  });
}

async function seedDriver(id: string, businessId: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: `Motorista ${id.slice(-2)}`,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${id.slice(-8)}`,
      cpf: `cpf-${id.slice(-8)}`,
      rg: `rg-${id.slice(-8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

async function mintToken(
  userId: string,
  businessId: string,
  driverId: string | null,
): Promise<string> {
  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    {
      tokenType: "access",
      role: driverId ? "BUSINESS_USER" : "BUSINESS_ADMIN",
      businessId,
      driverId,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: userId, expiresIn: "1h" },
  );
}

beforeAll(async () => {
  await seedBusiness(A, "66222888000101");
  await seedBusiness(B, "66222888000102");

  await seedDriver(DRIVER_A, A);
  await seedDriver(DRIVER_A2, A);
  await seedDriver(DRIVER_B, B);

  await prisma.user.create({
    data: {
      id: USER_A,
      name: "Gestora A",
      email: `gestora-a-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: A,
    },
  });

  await prisma.user.create({
    data: {
      id: DRIVER_USER_A,
      name: "Motorista A",
      email: `motorista-a-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER_A,
    },
  });

  tokenA = await mintToken(USER_A, A, null);
  driverTokenA = await mintToken(DRIVER_USER_A, A, DRIVER_A);

  // ------------------------------------------------ o que a empresa B tem
  const supplier = await prisma.supplier.create({
    data: { name: "Fornecedor B", cnpj: "77222888000199", businessId: B },
  });

  supplierB = supplier.id;

  const part = await prisma.part.create({
    data: {
      description: "Peça secreta da B",
      unit_price: 99.9,
      businessId: B,
      supplierId: supplier.id,
    },
  });

  created.partB = part.id;

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: B },
  });

  fuelTypeB = fuelType.id;

  const vehicle = await prisma.vehicle.create({
    data: {
      description: "Caminhão da B",
      license_plate: `BBB9B${Math.floor(Math.random() * 90) + 10}`,
      brand: "Scania",
      model: "R450",
      acquisition_date: new Date(),
      fleet_type: "OWNED",
      current_mileage: 0,
      maintenance_interval_km: 10000,
      maintenance_interval_months: 6,
      renavam: `rnv-adv-${randomUUID().slice(0, 8)}`,
      manufacturing_year: new Date(),
      model_year: new Date(),
      km_per_liter: 3,
      number_of_axles: 3,
      status: "ACTIVE",
      businessId: B,
      fuelTypeId: fuelType.id,
    },
  });

  created.vehicleB = vehicle.id;

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial B ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `88${Math.floor(Math.random() * 1e12)}`.slice(0, 14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-b-${randomUUID()}@exemplo.com.br`,
      businessId: B,
    },
  });

  const code = await prisma.trafficViolationCode.create({
    data: {
      code: `ADV${Math.floor(Math.random() * 100000)}`,
      description: "Excesso de velocidade",
      legal_basis: "CTB art. 218",
      violator_type: "Condutor",
      gravity: "SERIOUS",
      gravity_raw: "Grave",
      points: 5,
      competent_agency: "Estadual",
    },
  });

  const fine = await prisma.fine.create({
    data: {
      businessId: B,
      branchId: branch.id,
      driverId: DRIVER_B,
      vehicleId: vehicle.id,
      trafficViolationCodeId: code.id,
      violation_date: new Date(),
      due_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      amount: 195.23,
      points: 5,
    },
  });

  created.fineB = fine.id;

  await prisma.fuel.create({
    data: {
      businessId: B,
      branchId: branch.id,
      vehicleId: vehicle.id,
      driverId: DRIVER_B,
      fuelTypeId: fuelType.id,

      refueling_date: new Date("2026-01-10T12:00:00.000Z"),

      current_mileage: 1000,
      liters_amount: 300,
      price_per_liter: 6,

      // O número que o teste procura no corpo da resposta mais abaixo.
      total_amount: 1800,

      odometer_photo: "fuel/b/odometro.jpg",
    },
  });

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.fuel.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.part.deleteMany({ where: { businessId: { in: [A, B] } } });
  await prisma.supplier.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.fine.deleteMany({ where: { businessId: { in: [A, B] } } });

  // Depois das multas e dos abastecimentos, que apontam para eles.
  await prisma.vehicle.deleteMany({ where: { businessId: { in: [A, B] } } });
  await prisma.fuelType.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.branch.deleteMany({ where: { businessId: { in: [A, B] } } });

  await prisma.trafficViolationCode.deleteMany({
    where: { description: "Excesso de velocidade" },
  });

  await prisma.refreshToken.deleteMany({
    where: { userId: { in: [USER_A, DRIVER_USER_A] } },
  });

  await prisma.user.deleteMany({ where: { id: { in: [USER_A, DRIVER_USER_A] } } });

  await prisma.driver.deleteMany({
    where: { id: { in: [DRIVER_A, DRIVER_A2, DRIVER_B] } },
  });

  await prisma.businessEntitlement.deleteMany({
    where: { businessId: { in: [A, B] } },
  });

  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });

  await app?.close();
  await prisma.$disconnect();
});

const call = (
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  token: string,
  payload?: unknown,
) =>
  app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload: payload as never } : {}),
  });

/**
 * Recusado pela REGRA, e não pelo schema.
 *
 * A primeira versão deste arquivo passava com todas as correções revertidas:
 * os payloads eram inválidos, o zod recusava antes, e nove testes verdes
 * provavam que a validação de formulário funciona. Um teste de autorização que
 * nunca chega na autorização é pior do que não ter teste — ele dá a impressão
 * de cobertura exatamente onde não há.
 *
 * Então 422/"Validation Error" é FALHA aqui: significa que a requisição não
 * chegou onde precisava chegar.
 */
function expectRefused(response: { statusCode: number; body: string }, what: string) {
  expect(
    response.statusCode,
    `${what} respondeu ${response.statusCode}: ${response.body.slice(0, 200)}`,
  ).toBeGreaterThanOrEqual(400);

  expect(response.statusCode, what).toBeLessThan(500);

  expect(
    response.body,
    `${what} foi recusado pelo SCHEMA, não pela regra: ${response.body.slice(0, 200)}`,
  ).not.toContain("Validation Error");

  expect(response.statusCode, `${what} foi recusado pelo schema`).not.toBe(422);

  // Nem pelo entitlement. Uma empresa sem o módulo contratado leva 403 antes
  // de qualquer regra de tenant, e o teste passaria provando o entitlement.
  expect(
    response.body,
    `${what} foi recusado pelo ENTITLEMENT, não pela regra: ${response.body.slice(0, 200)}`,
  ).not.toContain("MODULE_NOT_ENABLED");

  expect(
    response.body,
    `${what} foi recusado pelo ENTITLEMENT, não pela regra`,
  ).not.toContain("não está habilitado");
}

describe("apagando a multa de outra empresa", () => {
  it("é recusado, e a multa continua lá", async () => {
    const response = await call(
      "DELETE",
      `/fines/delete-fine/${created.fineB}/business/${A}`,
      tokenA,
    );

    expectRefused(response, "delete-fine");

    // O que importa não é o código: é a linha continuar existindo.
    expect(
      await prisma.fine.count({ where: { id: created.fineB } }),
    ).toBe(1);
  });

  it("também é recusado quando o id da empresa da rota é o da vítima", async () => {
    // `enforceRequestedTenant` responde primeiro aqui, o que já basta — mas a
    // asserção é sobre a linha, não sobre quem recusou.
    const response = await call(
      "DELETE",
      `/fines/delete-fine/${created.fineB}/business/${B}`,
      tokenA,
    );

    expectRefused(response, "delete-fine com o tenant da vítima");

    expect(await prisma.fine.count({ where: { id: created.fineB } })).toBe(1);
  });
});

describe("reescrevendo o motorista de outra empresa", () => {
  it("é recusado, e o nome continua o mesmo", async () => {
    const before = await prisma.driver.findUniqueOrThrow({
      where: { id: DRIVER_B },
    });

    const response = await call(
      "PATCH",
      `/driver/update-driver/${DRIVER_B}/business/${A}`,
      tokenA,
      {
        // Um corpo VÁLIDO de propósito: o zod tem que deixar passar para que a
        // regra de tenant seja quem recusa. Um payload inválido aqui faria o
        // teste passar com a correção revertida — foi exatamente o que
        // aconteceu na primeira versão deste arquivo.
        name: "Motorista Sequestrado",
        birth_date: "1990-01-01",
        cnh: "12345678901",
        cpf: "39053344705",
        rg: "123456789",
        cep: "01001000",
        city: "São Paulo",
        uf: "SP",
        street: "Rua Invadida",
        address_number: "1",
        status: "INACTIVE",
        contract_type: "OWNED",
      },
    );

    expectRefused(response, "update-driver");

    const after = await prisma.driver.findUniqueOrThrow({
      where: { id: DRIVER_B },
    });

    // INACTIVE é o campo que importa: o `session-eligibility` transforma isso
    // em logout forçado do aplicativo dele no meio da rota.
    expect(after.name).toBe(before.name);
    expect(after.status).toBe(before.status);
  });
});

describe("roubando a peça de outra empresa", () => {
  it("é recusado mesmo mandando um businessId no corpo", async () => {
    // O exploit exato: a verificação de posse vivia num `else`, e mandar
    // qualquer `businessId` tomava o outro ramo e a pulava.
    const response = await call(
      "PATCH",
      `/part/update-part/${created.partB}/business/${A}`,
      tokenA,
      { businessId: A, description: "Reparentada" },
    );

    expectRefused(response, "update-part");

    const after = await prisma.part.findUniqueOrThrow({
      where: { id: created.partB },
    });

    expect(after.businessId).toBe(B);
    expect(after.description).toBe("Peça secreta da B");
  });
});

describe("lendo o abastecimento de outra empresa", () => {
  it("é recusado pelo id do veículo", async () => {
    const response = await call(
      "GET",
      `/fuel/get-previous-fuel/${created.vehicleB}?date=2030-01-01&businessId=${A}`,
      tokenA,
    );

    expectRefused(response, "get-previous-fuel");

    // E nada vazou no corpo: litros, valor, odômetro e posto ficam do outro
    // lado da parede.
    expect(JSON.stringify(response.json())).not.toContain("1800");
  });
});

describe("um motorista lendo o comprovante do colega", () => {
  it("é recusado, mesmo sendo da mesma empresa", async () => {
    // A verificação comparava com `null` — testava se a entrega TEM motorista,
    // verdadeiro para toda entrega atribuída a qualquer pessoa da empresa.
    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador A", businessId: A },
    });

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente do colega",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: A,
        shipperId: shipper.id,

        // Do OUTRO motorista da MESMA empresa.
        driverId: DRIVER_A2,
        status: "DELIVERED",
        delivered_at: new Date(),
      },
    });

    const response = await call(
      "GET",
      `/delivery/proof-document/${delivery.id}/business/${A}`,
      driverTokenA,
    );

    expectRefused(response, "proof-document do colega");

    expect(JSON.stringify(response.json())).not.toContain("Cliente do colega");

    await prisma.delivery.deleteMany({ where: { id: delivery.id } });
    await prisma.shipper.deleteMany({ where: { id: shipper.id } });
  });
});

describe("um motorista gerenciando o catálogo da operação", () => {
  it("não cria embarcador", async () => {
    const response = await call("POST", `/shipper/create-shipper/${A}`, driverTokenA, {
      name: "Embarcador do motorista",
    });

    expectRefused(response, "create-shipper como motorista");

    expect(
      await prisma.shipper.count({
        where: { businessId: A, name: "Embarcador do motorista" },
      }),
    ).toBe(0);
  });

  it("não cria tipo de ocorrência", async () => {
    const response = await call(
      "POST",
      `/occurrence-type/create-occurrence-type/${A}`,
      driverTokenA,
      { name: "Inventado pelo motorista", blocks_delivery: false },
    );

    expectRefused(response, "create-occurrence-type como motorista");
  });
});

describe("um motorista fechando a própria entrega sem comprovar", () => {
  it("é recusado: a comprovação é que carrega a evidência", async () => {
    const shipper = await prisma.shipper.create({
      data: { name: "Embarcador A2", businessId: A },
    });

    const reason = await prisma.statusChangeReason.create({
      data: { name: "Ajuste manual", businessId: A } as never,
    });

    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente sem canhoto",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: A,
        shipperId: shipper.id,
        driverId: DRIVER_A,
        status: "IN_TRANSIT",
      },
    });

    const response = await call(
      "PATCH",
      `/delivery/update-delivery-status/${delivery.id}/business/${A}`,
      driverTokenA,
      { status: "DELIVERED", reasonId: reason.id },
    );

    expectRefused(response, "override de status como motorista");

    // Sem foto, sem assinatura, sem GPS: é exatamente o que
    // `register-delivery-proof` existe para exigir, e este caminho contornava.
    const after = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });

    expect(after.status).toBe("IN_TRANSIT");

    await prisma.delivery.deleteMany({ where: { id: delivery.id } });
    await prisma.statusChangeReason.deleteMany({ where: { id: reason.id } });
    await prisma.shipper.deleteMany({ where: { id: shipper.id } });
  });
});
