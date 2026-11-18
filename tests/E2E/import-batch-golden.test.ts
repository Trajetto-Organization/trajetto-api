import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { BackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { JobLeaseLostError } from "@/shared/jobs/job-errors";
import { JobRunner, type JobContext } from "@/shared/jobs/job-runner";
import { registerJobHandlers } from "@/shared/jobs/job-handlers";
import type { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";
import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";
import { spreadsheetImportJob } from "@/modules/import/services/spreadsheet-import-job";

/**
 * The golden test of the durable import in batches (plano-escala F3-23c).
 *
 * The same sheet of 227 rows goes into four companies that start alike:
 *
 *  - ROWS: one row per transaction (IMPORT_ROWS_PER_TRANSACTION=1), the
 *    reference;
 *  - BATCH: 100 rows per transaction;
 *  - FALLBACK: 100 per transaction, with the first batch failing once (a
 *    write that throws), so it is redone row by row;
 *  - KILLED: 100 per transaction, the run killed while committing its
 *    second batch (the transaction rolled back, nothing more written) and
 *    resumed by another runner.
 *
 * Each must come out exactly as ROWS: the report line by line, the counters,
 * the deliveries (with their items and routes), the routes and their stops
 * in order, and the webhook rows of delivery.created and delivery.assigned.
 * The sheet has what the batch decides differently from one row at a time
 * if it is wrong: duplicates of keys and orders inside the file and against
 * the database, rows with neither (on routes), a parse error, and route
 * groups that cross the batches.
 */
const prisma = createPrismaClient();

const COMPANIES = {
  ROWS: "018fd300-0000-7000-8000-00000000000a",
  BATCH: "018fd300-0000-7000-8000-00000000000b",
  FALLBACK: "018fd300-0000-7000-8000-00000000000c",
  KILLED: "018fd300-0000-7000-8000-00000000000d",
} as const;

type Company = keyof typeof COMPANIES;

const CNH = "44433322211";

const seeded: Record<
  Company,
  { shipperId: string; userId: string; driverId: string }
> = {} as never;

let cnpjSeq = 0;

async function seedCompany(name: Company): Promise<void> {
  const businessId = COMPANIES[name];
  const shipperId = randomUUID();
  const userId = randomUUID();
  const driverId = randomUUID();

  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id: businessId,
      corporate_reason: `Transportadora ${name}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(11222666000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${businessId}@exemplo.com.br`,
    },
  });
  await prisma.businessEntitlement.create({
    data: { businessId, module: "DELIVERIES", enabled: true },
  });
  await prisma.shipper.create({
    data: { id: shipperId, name: "Embarcador", businessId },
  });
  await prisma.user.create({
    data: {
      id: userId,
      name: "Despachante",
      email: `${userId}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId,
    },
  });
  await prisma.driver.create({
    data: {
      id: driverId,
      name: "Motorista",
      birth_date: new Date("1990-01-01"),
      cnh: CNH,
      cpf: `${driverId}-cpf`,
      rg: `${driverId}-rg`,
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
  await prisma.webhookEndpoint.create({
    data: {
      name: "ERP",
      url: "https://erp.exemplo.com.br/webhooks",
      secret: "whsec_teste",
      topics: ["delivery.created", "delivery.assigned"],
      businessId,
    },
  });

  // What the database already had: the duplicates of the sheet's last rows.
  for (const data of [
    { recipient_name: "Antiga por chave", invoice_key: keyOf(0) },
    { recipient_name: "Antiga por pedido", code: "GOLD-0" },
  ]) {
    await prisma.delivery.create({
      data: {
        ...data,
        city: "São Paulo",
        uf: "SP",
        street: "Rua",
        businessId,
        shipperId,
      },
    });
  }

  seeded[name] = { shipperId, userId, driverId };
}

const HEADER = [
  "Destinatário",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Chave da NF-e",
  "Pedido",
  "Item",
  "Quantidade",
  "Rota",
  "CNH do motorista",
];

function keyOf(n: number): string {
  return `3526091122233300018155001${String(n).padStart(19, "0")}`;
}

function line(
  recipient: string,
  {
    key = "",
    code = "",
    route = "",
  }: { key?: string; code?: string; route?: string },
): string[] {
  return [
    recipient,
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
    key,
    code,
    `Caixa de ${recipient}`,
    "2",
    route,
    route ? CNH : "",
  ];
}

/** 227 rows: see the top of the file. */
function sheet(): string[][] {
  const rows: string[][] = [];

  for (let n = 1; n <= 220; n += 1) {
    rows.push(
      line(`Destinatário ${n}`, {
        key: n % 10 === 0 ? keyOf(n) : "",
        // Every 7th without an order (and, unless a 10th, without a key).
        code: n % 7 === 0 ? "" : `GOLD-${n}`,
        // Two groups across the first two batches, one in the third.
        route:
          n <= 140
            ? n % 2 === 1
              ? "Rota Ímpar"
              : "Rota Par"
            : n <= 180
              ? "Rota Tarde"
              : "",
      }),
    );
  }

  // Duplicates inside the file: in the same batch (the order of a keyed
  // row, a key), an order of the first batch in the second, a key of the
  // second in the third.
  rows.splice(50, 0, line("Repete o pedido de uma chave", { code: "GOLD-10" }));
  rows.splice(60, 0, line("Repete chave no lote", { key: keyOf(20) }));
  rows.splice(120, 0, line("Repete pedido", { code: "GOLD-3" }));
  rows.splice(
    210,
    0,
    line("Repete chave", { key: keyOf(150), code: "GOLD-X" }),
  );

  // Against the database, and one the parser refuses.
  rows.push(line("Repete a antiga por pedido", { code: "GOLD-0" }));
  rows.push(line("Repete a antiga por chave", { key: keyOf(0) }));
  rows.push(line("Chave curta", { key: "123", code: "GOLD-CURTA" }));

  return rows;
}

function csv(rows: string[][]): string {
  const text = [HEADER, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

const useCase = () => container.resolve(ImportDeliverySpreadsheetUseCase);

async function enqueue(company: Company): Promise<string> {
  const { shipperId, userId } = seeded[company];
  const record = await useCase().start({
    userId,
    businessId: COMPANIES[company],
    filename: "dourado.csv",
    content: csv(sheet()),
    shipperId,
  });

  return record.id;
}

function runner(owner: string, run?: (job: JobContext) => Promise<void>) {
  const instance = new JobRunner({
    store: new BackgroundJobRepository(),
    sweepIntervalMs: 60_000,
    owner: () => owner,
    renewEveryMs: 600_000,
  });

  if (run) {
    instance.register("SPREADSHEET_IMPORT", { ...spreadsheetImportJob, run });
  } else {
    registerJobHandlers(instance);
  }

  return instance;
}

async function withRowsPerTransaction<T>(
  rows: number,
  work: () => Promise<T>,
): Promise<T> {
  const before = env.IMPORT_ROWS_PER_TRANSACTION;

  env.IMPORT_ROWS_PER_TRANSACTION = rows;

  try {
    return await work();
  } finally {
    env.IMPORT_ROWS_PER_TRANSACTION = before;
  }
}

/** What the operator and the ERP see of one import, without ids. */
async function outcomeOf(company: Company, importId: string) {
  const businessId = COMPANIES[company];
  const record = await prisma.import.findUniqueOrThrow({
    where: { id: importId },
  });
  const report = record.report as {
    rows: Array<Record<string, unknown>>;
    routes: Array<{ name: string; stops: number }>;
    unknownHeaders: string[];
  };

  const deliveries = await prisma.delivery.findMany({
    where: { importId },
    select: {
      recipient_name: true,
      code: true,
      invoice_key: true,
      status: true,
      items: { select: { description: true, quantity: true } },
      stops: { select: { sequence: true, route: { select: { name: true } } } },
    },
    orderBy: { recipient_name: "asc" },
  });

  const routes = await prisma.route.findMany({
    where: { importId },
    select: {
      name: true,
      stops: {
        select: { delivery: { select: { recipient_name: true } } },
        orderBy: { sequence: "asc" },
      },
    },
    orderBy: { name: "asc" },
  });

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: { businessId },
    select: { id: true },
  });
  const webhooks = await prisma.webhookDelivery.findMany({
    where: { endpointId: { in: endpoints.map((endpoint) => endpoint.id) } },
    select: { topic: true, payload: true },
  });

  const hooked = webhooks
    .map(({ topic, payload }) => {
      const body = payload as Record<string, unknown>;
      const data = (body.data as Record<string, unknown> | undefined) ?? body;

      return `${topic}|${String(data.code ?? "")}|${String(data.invoice_key ?? "")}|${String(data.recipient_name ?? "")}`;
    })
    .sort();

  return {
    status: record.status,
    counters: [record.imported, record.duplicated, record.invalid],
    rows: report.rows,
    unknownHeaders: report.unknownHeaders,
    reportRoutes: report.routes.map(({ name, stops }) => ({ name, stops })),
    deliveries,
    routes: routes.map((route) => ({
      name: route.name,
      stops: route.stops.map((stop) => stop.delivery.recipient_name),
    })),
    webhooks: hooked,
  };
}

let reference: Awaited<ReturnType<typeof outcomeOf>>;

beforeAll(async () => {
  for (const company of Object.keys(COMPANIES) as Company[]) {
    await seedCompany(company);
  }

  // The container's registrations come with the app.
  const { app } = await import("@/http");
  await app.ready();

  env.IMPORT_DURABLE_JOBS = true;

  const importId = await withRowsPerTransaction(1, async () => {
    const id = await enqueue("ROWS");

    await runner("rows").processBatch();

    return id;
  });

  reference = await outcomeOf("ROWS", importId);
}, 180_000);

afterAll(async () => {
  env.IMPORT_DURABLE_JOBS = false;
  await prisma.$disconnect();
});

describe("the durable import in batches", () => {
  it("decides the reference sheet as the plan says", () => {
    expect(reference.status).toBe("COMPLETED");
    // 220 rows and 6 duplicates decided, the short key refused by the parser.
    expect(reference.counters).toEqual([220, 6, 1]);
    expect(reference.reportRoutes.map((route) => route.name)).toEqual([
      "Rota Ímpar",
      "Rota Par",
      "Rota Tarde",
    ]);
    expect(
      reference.webhooks.filter((hook) => hook.startsWith("delivery.created")),
    ).toHaveLength(220);
    expect(
      reference.webhooks.filter((hook) => hook.startsWith("delivery.assigned")),
    ).toHaveLength(180);
  });

  it(
    "writes, 100 rows a transaction, exactly what one row a transaction writes",
    { timeout: 120_000 },
    async () => {
      const importId = await withRowsPerTransaction(100, async () => {
        const id = await enqueue("BATCH");

        await runner("batch").processBatch();

        return id;
      });

      expect(await outcomeOf("BATCH", importId)).toEqual(reference);
    },
  );

  it(
    "redoes a batch that failed row by row, and still writes the same",
    { timeout: 120_000 },
    async () => {
      const deliveries =
        container.resolve<IDeliveryRepository>("DeliveryRepository");
      const original = deliveries.createDelivery.bind(deliveries);
      let calls = 0;

      const spy = vi
        .spyOn(deliveries, "createDelivery")
        .mockImplementation(async (...args) => {
          calls += 1;

          // The batch's 50th write fails once: the whole batch rolls back.
          if (calls === 50) throw new Error("falha simulada no meio do lote");

          return original(...args);
        });

      try {
        const importId = await withRowsPerTransaction(100, async () => {
          const id = await enqueue("FALLBACK");

          await runner("fallback").processBatch();

          return id;
        });

        expect(calls).toBeGreaterThan(220);
        expect(await outcomeOf("FALLBACK", importId)).toEqual(reference);
      } finally {
        spy.mockRestore();
      }
    },
  );

  it(
    "resumes a run killed in its second batch, every row written once",
    { timeout: 120_000 },
    async () => {
      const importId = await withRowsPerTransaction(100, async () => {
        const id = await enqueue("KILLED");
        let commits = 0;

        const killed = runner("killed", async (job) => {
          try {
            await useCase().runJob({
              ...job,
              checkpoint: async (progress, tx) => {
                if (tx && ++commits === 2) throw new JobLeaseLostError(job.id);

                await job.checkpoint(progress, tx);
              },
            });
          } catch (error) {
            if (error instanceof JobLeaseLostError) {
              await new Promise(() => undefined);
            }

            throw error;
          }
        });

        void killed.processBatch();

        await vi.waitFor(() => expect(commits).toBeGreaterThanOrEqual(2), {
          timeout: 60_000,
        });

        await prisma.$executeRaw`
          UPDATE "background_job"
          SET "leaseExpiresAt" = now() - interval '1 second'
          WHERE "subjectId" = ${id}
        `;

        expect(await runner("survivor").processBatch()).toBe(1);

        return id;
      });

      expect(await outcomeOf("KILLED", importId)).toEqual(reference);
      expect(
        await prisma.backgroundJob.findFirst({
          where: { subjectId: importId },
          select: { status: true, attempts: true },
        }),
      ).toEqual({ status: "SUCCEEDED", attempts: 2 });
    },
  );
});
