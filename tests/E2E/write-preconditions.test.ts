import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { DeliveryRepository } from "@/modules/delivery/repositories/delivery-repository";
import { VehicleRepository } from "@/modules/vehicle/repositories/vehicle-repository";
import { AccountPayableRepository } from "@/modules/account-payable/repositories/account-payable-repository";
import { UserRepository } from "@/modules/user/repositories/user-repository";

/**
 * Duas requisições ao mesmo tempo, e só uma pode vencer.
 *
 * Todo teste de corrida que roda contra um fake prova o fake. Estes rodam
 * contra o Postgres e disparam as escritas DE VERDADE em paralelo — é a única
 * forma de saber se a pré-condição está no `where` ou só no comentário.
 *
 * Os três casos vieram de uma auditoria adversarial, e os três são
 * read-then-write num lugar onde o produto usa pré-condição em todos os
 * vizinhos.
 */
const prisma = new PrismaClient();

const CARRIER = "018fe000-0000-7000-8000-00000000000a";

const deliveries = new DeliveryRepository();
const vehicles = new VehicleRepository();
const payables = new AccountPayableRepository();

let branchId = "";
let fuelTypeId = "";
let shipperId = "";
let userId = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora das Corridas",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "10222888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `corrida-${randomUUID()}@exemplo.com.br`,

      // Dez vagas contratadas.
      vehicle_limit: 10,
    },
  });

  const branch = await prisma.branch.create({
    data: {
      corporate_reason: `Filial ${randomUUID().slice(0, 8)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: `12${Math.floor(Math.random() * 1e12)}`.slice(0, 14),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `filial-corrida-${randomUUID()}@exemplo.com.br`,
      businessId: CARRIER,
    },
  });

  branchId = branch.id;

  const fuelType = await prisma.fuelType.create({
    data: { description: "Diesel", businessId: CARRIER },
  });

  fuelTypeId = fuelType.id;

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: CARRIER },
  });

  shipperId = shipper.id;

  const user = await prisma.user.create({
    data: {
      name: "Gestora",
      email: `gestora-corrida-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: CARRIER,
    },
  });

  userId = user.id;
}, 120_000);

afterAll(async () => {
  await prisma.accountPayable.deleteMany({ where: { businessId: CARRIER } });
  await prisma.delivery.deleteMany({ where: { businessId: CARRIER } });

  await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });
  await prisma.fuelType.deleteMany({ where: { businessId: CARRIER } });

  await prisma.shipper.deleteMany({ where: { businessId: CARRIER } });
  await prisma.user.deleteMany({ where: { businessId: CARRIER } });

  await prisma.branch.deleteMany({ where: { businessId: CARRIER } });
  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

function vehicleData(suffix: string) {
  return {
    description: "Caminhão",
    license_plate: `RC${suffix}`.slice(0, 10),
    brand: "Volvo",
    model: "FH",
    acquisition_date: new Date(),
    fleet_type: "OWNED" as const,
    current_mileage: 0,
    maintenance_interval_km: 10000,
    maintenance_interval_months: 6,
    renavam: `rnv-rc-${suffix}`,
    manufacturing_year: new Date(),
    model_year: new Date(),
    km_per_liter: 3,
    number_of_axles: 3,
    status: "ACTIVE" as const,
    businessId: CARRIER,
    fuelTypeId,
  };
}

describe("editando a entrega enquanto o motorista comprova", () => {
  it("a edição é recusada e nada é reescrito", async () => {
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente Original",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId,
        status: "PENDING",
      },
    });

    // A comprovação landou na janela entre a leitura da use case e a escrita.
    await prisma.delivery.update({
      where: { id: delivery.id },
      data: { status: "DELIVERED", delivered_at: new Date() },
    });

    // A edição, que leu PENDING lá atrás, chega agora.
    await expect(
      deliveries.updateDelivery(
        delivery.id,
        { recipient_name: "Reescrito" },
        "PENDING",
      ),
    ).rejects.toThrow();

    const after = await prisma.delivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });

    // O canhoto já estava assinado e o webhook já tinha saído para o ERP do
    // cliente. Reescrever destinatário e endereço em cima disso é o defeito.
    expect(after.recipient_name).toBe("Cliente Original");
    expect(after.status).toBe("DELIVERED");
  });

  it("a edição passa quando o status é mesmo o esperado", async () => {
    // A outra metade do par: sem ela o teste acima passaria para um
    // repositório que recusa tudo.
    const delivery = await prisma.delivery.create({
      data: {
        recipient_name: "Cliente Editável",
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId: CARRIER,
        shipperId,
        status: "PENDING",
      },
    });

    await deliveries.updateDelivery(
      delivery.id,
      { recipient_name: "Editado" },
      "PENDING",
    );

    expect(
      (await prisma.delivery.findUniqueOrThrow({ where: { id: delivery.id } }))
        .recipient_name,
    ).toBe("Editado");
  });
});

describe("a frota contratada sob concorrência", () => {
  it("não passa do limite com dez cadastros ao mesmo tempo", async () => {
    await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });

    // Nove ocupadas de dez.
    for (let n = 0; n < 9; n += 1) {
      await prisma.vehicle.create({ data: vehicleData(`base${n}`) });
    }

    /**
     * Conexões SEPARADAS, uma por tentativa.
     *
     * Com um cliente Prisma só, as dez chamadas se enfileiram no mesmo pool e
     * o interleaving acaba serializando por acidente — o teste passava até com
     * a transação inteira removida, provando nada. Um cliente por tentativa
     * são dez conexões de verdade disputando, que é o que acontece com dez
     * réplicas atendendo dez requisições.
     */
    const clients = Array.from({ length: 10 }, () => new PrismaClient());

    const attempts = await Promise.all(
      clients.map((client, n) =>
        new VehicleRepository(client)
          .createVehicleWithinLimit(vehicleData(`race${n}`), {
            max: 10,
            occupiesSlot: true,
          })
          .then((result) => Boolean(result.vehicle))
          .catch(() => false),
      ),
    );

    await Promise.all(clients.map((client) => client.$disconnect()));

    const created = attempts.filter(Boolean).length;

    // Exatamente uma vaga sobrava.
    expect(created).toBe(1);

    expect(
      await prisma.vehicle.count({
        where: { businessId: CARRIER, status: { not: "INACTIVE" } },
      }),
    ).toBe(10);
  });

  it("deixa criar quando há vaga", async () => {
    await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });

    const result = await vehicles.createVehicleWithinLimit(
      vehicleData("livre"),
      { max: 10, occupiesSlot: true },
    );

    expect(result.vehicle).not.toBeNull();
  });

  it("ignora o limite para um veículo que não ocupa vaga", async () => {
    await prisma.vehicle.deleteMany({ where: { businessId: CARRIER } });

    for (let n = 0; n < 10; n += 1) {
      await prisma.vehicle.create({ data: vehicleData(`cheio${n}`) });
    }

    // Cadastrar direto como INACTIVE é legítimo mesmo com a frota cheia: ele
    // não ocupa vaga, e ativar depois passa pela porteira da reativação.
    const result = await vehicles.createVehicleWithinLimit(
      { ...vehicleData("inativo"), status: "INACTIVE" },
      { max: 10, occupiesSlot: false },
    );

    expect(result.vehicle).not.toBeNull();
  });
});

describe("apagando uma conta que está sendo paga", () => {
  it("é recusado depois que o pagamento é carimbado", async () => {
    const payable = await prisma.accountPayable.create({
      data: {
        businessId: CARRIER,
        branchId,
        registrationUserId: userId,
        due_date: new Date(),
        amount: 1500,
        category: "OTHER",
      } as never,
    });

    await prisma.accountPayable.update({
      where: { id: payable.id },
      data: { payment_date: new Date(), amount_paid: 1500 },
    });

    await expect(
      payables.deleteAccountPayable(payable.id, CARRIER),
    ).rejects.toThrow();

    // Um registro financeiro liquidado não some.
    expect(
      await prisma.accountPayable.count({ where: { id: payable.id } }),
    ).toBe(1);
  });

  it("apaga uma conta que continua em aberto", async () => {
    const payable = await prisma.accountPayable.create({
      data: {
        businessId: CARRIER,
        branchId,
        registrationUserId: userId,
        due_date: new Date(),
        amount: 900,
        category: "OTHER",
      } as never,
    });

    await payables.deleteAccountPayable(payable.id, CARRIER);

    expect(
      await prisma.accountPayable.count({ where: { id: payable.id } }),
    ).toBe(0);
  });

  it("não apaga a conta de outra empresa", async () => {
    const payable = await prisma.accountPayable.create({
      data: {
        businessId: CARRIER,
        branchId,
        registrationUserId: userId,
        due_date: new Date(),
        amount: 100,
        category: "OTHER",
      } as never,
    });

    await expect(
      payables.deleteAccountPayable(payable.id, randomUUID()),
    ).rejects.toThrow();

    expect(
      await prisma.accountPayable.count({ where: { id: payable.id } }),
    ).toBe(1);
  });
});

describe("apagando MASTERs ao mesmo tempo", () => {
  /**
   * MASTER é o único papel que cria outro MASTER.
   *
   * Contar e depois apagar não serve: dois pedidos simultâneos apagando
   * MASTERs DIFERENTES leem `total = 2`, os dois passam pela porteira, e
   * sobram zero — a plataforma trancada por fora, sem caminho de volta pela
   * própria aplicação.
   */
  const masters: string[] = [];

  async function seedMaster(): Promise<string> {
    const user = await prisma.user.create({
      data: {
        name: "Master",
        email: `master-corrida-${randomUUID()}@exemplo.com.br`,
        password: "nao-usado",
        role: "MASTER",
      },
    });

    masters.push(user.id);

    return user.id;
  }

  it("nunca deixa a plataforma sem nenhum", async () => {
    // O estado que importa: EXATAMENTE dois. Quantos já existem no banco não
    // é controlável aqui, então a asserção é sobre não zerar.
    const before = await prisma.user.count({ where: { role: "MASTER" } });

    const needed = Math.max(0, 2 - before);

    for (let n = 0; n < needed; n += 1) await seedMaster();

    const all = await prisma.user.findMany({
      where: { role: "MASTER" },
      select: { id: true },
    });

    // Conexões separadas, pelo mesmo motivo do limite de frota: com um
    // cliente só as chamadas serializam por acidente.
    const clients = all.map(() => new PrismaClient());

    await Promise.all(
      all.map((master, index) =>
        new UserRepository(clients[index])
          .deleteMasterUserKeepingOne(master.id)
          .catch(() => null),
      ),
    );

    await Promise.all(clients.map((client) => client.$disconnect()));

    // Um sobra. Sempre.
    expect(
      await prisma.user.count({ where: { role: "MASTER" } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("recusa quando só resta um", async () => {
    const remaining = await prisma.user.findFirstOrThrow({
      where: { role: "MASTER" },
    });

    const count = await prisma.user.count({ where: { role: "MASTER" } });

    if (count === 1) {
      expect(
        await new UserRepository().deleteMasterUserKeepingOne(remaining.id),
      ).toBeNull();
    }
  });

  it("recusa um id que não é MASTER", async () => {
    // Não é exclusão silenciosa: o alvo tem que estar entre os travados.
    const plain = await prisma.user.findFirstOrThrow({
      where: { businessId: CARRIER, role: "BUSINESS_ADMIN" },
    });

    expect(
      await new UserRepository().deleteMasterUserKeepingOne(plain.id),
    ).toBeNull();

    expect(await prisma.user.count({ where: { id: plain.id } })).toBe(1);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: masters } } });
  });
});
