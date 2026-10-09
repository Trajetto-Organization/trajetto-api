import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { OccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/occurrence-type-repository";
import { getOrCreateCurrentPeriod } from "@/shared/ai/ai-quota-service";

/**
 * "Get or create" written as `upsert({ where, create, update: {} })`.
 *
 * It reads as one atomic statement and is not one. Prisma 6 only emits
 * `INSERT ... ON CONFLICT` when `update` has something to set; with an empty
 * one it runs a SELECT and then an INSERT, so callers racing on a row that
 * does not exist yet all pass the SELECT and every one but the first gets
 * P2002 (measured on the activity trail, tests/E2E/repository-guards.test.ts).
 *
 * Each case below is a place that promised convergence and delivered an
 * error instead:
 *
 *  - the chat thread, on two first messages to a driver at once — one of the
 *    two sends failed;
 *  - the system occurrence type a proof rejection records — one of two
 *    rejections landing together failed;
 *  - the AI usage period, created inside the request's transaction on the
 *    first analysis of the month — the P2002 aborted it and requestAnalysis
 *    read it as "already running": that record was never analysed.
 *
 * Two PrismaClients, several rounds: the window is short, and one round can
 * happen to serialise on its own.
 */
const prisma = new PrismaClient();
const otherConnection = new PrismaClient();

const clients = [prisma, otherConnection, prisma, otherConnection, prisma];

const ROUNDS = 5;

let carrierSeq = 0;

async function seedCarrier(): Promise<string> {
  carrierSeq += 1;

  const business = await prisma.business.create({
    data: {
      corporate_reason: `Transportadora da Corrida ${carrierSeq}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(61333888000100 + carrierSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `corrida-${randomUUID()}@exemplo.com.br`,
    },
  });

  return business.id;
}

async function seedDriver(businessId: string): Promise<string> {
  const driver = await prisma.driver.create({
    data: {
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: randomUUID().slice(0, 11),
      cpf: `cpf-${randomUUID()}`,
      rg: `rg-${randomUUID()}`,
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

  return driver.id;
}

/** Every rejection's Prisma code (or message), and the ids the rest got. */
function outcome(results: PromiseSettledResult<{ id: string }>[]) {
  return {
    failures: results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) =>
        result.reason instanceof Prisma.PrismaClientKnownRequestError
          ? result.reason.code
          : String(result.reason),
      ),
    ids: new Set(
      results
        .filter(
          (result): result is PromiseFulfilledResult<{ id: string }> =>
            result.status === "fulfilled",
        )
        .map((result) => result.value.id),
    ),
  };
}

let carrier = "";

beforeAll(async () => {
  carrier = await seedCarrier();
}, 60_000);

afterAll(async () => {
  await otherConnection.$disconnect();
  await prisma.$disconnect();
});

describe("the first messages to a driver, sent at the same moment", () => {
  it("land in one thread, and none of them fails", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const driverId = await seedDriver(carrier);

      const { failures, ids } = outcome(
        await Promise.allSettled(
          clients.map((client) =>
            new ChatRepository(client).getOrCreateThread(carrier, driverId),
          ),
        ),
      );

      expect(failures, `rodada ${round}: um envio concorrente falhou`).toEqual([]);
      expect(ids.size).toBe(1);

      expect(
        await prisma.chatThread.count({ where: { businessId: carrier, driverId } }),
      ).toBe(1);
    }
  });
});

describe("the system occurrence type, recorded by rejections landing together", () => {
  it("is one row, and every rejection gets it", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const name = `Comprovante recusado ${round} ${randomUUID().slice(0, 6)}`;

      const { failures, ids } = outcome(
        await Promise.allSettled(
          clients.map((client) =>
            new OccurrenceTypeRepository(client).ensureByName(carrier, {
              name,
              description: "Registrado pela revisão do comprovante",
              blocks_delivery: false,
              requires_photo: false,
            }),
          ),
        ),
      );

      expect(failures, `rodada ${round}: uma recusa concorrente falhou`).toEqual([]);
      expect(ids.size).toBe(1);

      expect(
        await prisma.occurrenceType.count({ where: { businessId: carrier, name } }),
      ).toBe(1);
    }
  });
});

describe("the AI usage period, on the first analyses of the month", () => {
  it("is created once inside each racing transaction, and no transaction aborts", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      // A company with no period yet: the month's first analyses.
      const businessId = await seedCarrier();

      const { failures, ids } = outcome(
        await Promise.allSettled(
          clients.map((client) =>
            // Inside a transaction, as requestAnalysis calls it: a P2002
            // there aborts the whole request, not only this statement.
            client.$transaction((tx) => getOrCreateCurrentPeriod(tx, businessId)),
          ),
        ),
      );

      expect(failures, `rodada ${round}: uma transação concorrente abortou`).toEqual([]);
      expect(ids.size).toBe(1);

      expect(await prisma.aIUsagePeriod.count({ where: { businessId } })).toBe(1);
    }
  });
});
