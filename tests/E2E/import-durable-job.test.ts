import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sign } from "jsonwebtoken";

import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { container } from "tsyringe";

import auth from "@/config/auth";
import { env } from "@/env";
import { createPrismaClient } from "@/shared/database/database-client";
import { BackgroundJobRepository } from "@/shared/jobs/background-job-repository";
import { JobLeaseLostError } from "@/shared/jobs/job-errors";
import { JobRunner, type JobContext } from "@/shared/jobs/job-runner";
import { registerJobHandlers } from "@/shared/jobs/job-handlers";
import { ImportRepository } from "@/modules/import/repositories/import-repository";
import { ImportDeliverySpreadsheetUseCase } from "@/modules/import/usecases/import-delivery-spreadsheet/import-delivery-spreadsheet-usecase";
import { releaseImportObjects } from "@/modules/import/services/import-object-release";
import { spreadsheetImportJob } from "@/modules/import/services/spreadsheet-import-job";
import { UploadService } from "@/shared/services/upload-service";

/**
 * The spreadsheet import as a durable job (plano-escala F3-23a), over the
 * real stack: the HTTP upload with IMPORT_DURABLE_JOBS, the stored file, the
 * job of the `jobs` queue and the runner that drains it.
 *
 *  - a run killed in the middle of the file (its row's transaction rolled
 *    back, nothing more written, the job left PROCESSING) is resumed by
 *    another runner once the lease runs out: every row's delivery exists
 *    once, and the report is the one the in-memory path writes for the same
 *    file — keyless rows on a route and a route built after the resume
 *    included;
 *  - past the company's cap the upload is refused with 429 IMPORT_BUSY and
 *    Retry-After, and nothing is left behind: no record, no stored file;
 *  - the abandoned-import sweep leaves an upload a live job owns alone;
 *  - a job that fails for good closes the record with the failure's line;
 *  - the stored files are released an hour after a success and seven days
 *    after a failure, and a job keeps its row until its file is gone.
 */
const prisma = createPrismaClient();

const CARRIER = "018fd200-0000-7000-8000-00000000000a";
const MIRROR = "018fd200-0000-7000-8000-00000000000b";
const SHIPPER = "018fd200-0000-7000-8000-0000000000f1";
const MIRROR_SHIPPER = "018fd200-0000-7000-8000-0000000000f2";
const DRIVER = "018fd200-0000-7000-8000-0000000000d1";
const MIRROR_DRIVER = "018fd200-0000-7000-8000-0000000000d2";
const CNH = "55566677788";

let app: Awaited<typeof import("@/http")>["app"];
let token: string;
let busyToken: string;
let dispatcher: string;
let mirrorDispatcher: string;

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
      cnpj: String(11222555000180 + cnpjSeq),
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

async function seedAdmin(businessId: string): Promise<{
  id: string;
  token: string;
}> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: "Usuário",
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role: "BUSINESS_ADMIN",
      businessId,
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

  return {
    id,
    token: sign(
      { tokenType: "access", sessionVersion: 0, familyId },
      auth.secret_token,
      { subject: id, expiresIn: "15m" },
    ),
  };
}

async function seedDriver(id: string, businessId: string): Promise<void> {
  await prisma.driver.create({
    data: {
      id,
      name: "Motorista da planilha",
      birth_date: new Date("1990-01-01"),
      cnh: CNH,
      cpf: `${id}-cpf`,
      rg: `${id}-rg`,
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

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(MIRROR);
  await seedDriver(DRIVER, CARRIER);
  await seedDriver(MIRROR_DRIVER, MIRROR);

  await prisma.shipper.createMany({
    data: [
      { id: SHIPPER, name: "Embarcador", businessId: CARRIER },
      { id: MIRROR_SHIPPER, name: "Embarcador", businessId: MIRROR },
    ],
  });

  const admin = await seedAdmin(CARRIER);
  token = admin.token;
  dispatcher = admin.id;
  busyToken = (await seedAdmin(CARRIER)).token;
  mirrorDispatcher = (await seedAdmin(MIRROR)).id;

  ({ app } = await import("@/http"));
  await app.ready();

  env.IMPORT_DURABLE_JOBS = true;
}, 60_000);

afterAll(async () => {
  env.IMPORT_DURABLE_JOBS = false;
  await app?.close();
  await prisma.$disconnect();
});

const HEADER = [
  "Destinatário",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Pedido",
  "Rota",
  "CNH do motorista",
];

function csv(rows: string[][]): string {
  const text = [HEADER, ...rows]
    .map((row) => row.map((cell) => `"${cell}"`).join(";"))
    .join("\n");

  return Buffer.from(text, "utf8").toString("base64");
}

function row(recipient: string, code: string, route?: string) {
  return [
    recipient,
    "01001000",
    "São Paulo",
    "SP",
    "Praça da Sé",
    code,
    route ?? "",
    route ? CNH : "",
  ];
}

async function post(content: string, as = token) {
  return app.inject({
    method: "POST",
    url: `/import/import-spreadsheet/${CARRIER}`,
    headers: { authorization: `Bearer ${as}` },
    payload: {
      filename: `carga-${randomUUID().slice(0, 8)}.csv`,
      content,
      shipperId: SHIPPER,
    },
  });
}

function runnerWith(run: (job: JobContext) => Promise<void>): JobRunner {
  const runner = new JobRunner({
    store: new BackgroundJobRepository(),
    sweepIntervalMs: 60_000,
    owner: () => `runner-${randomUUID().slice(0, 4)}`,
    renewEveryMs: 600_000,
  });

  runner.register("SPREADSHEET_IMPORT", { ...spreadsheetImportJob, run });

  return runner;
}

const useCase = () => container.resolve(ImportDeliverySpreadsheetUseCase);

/** Report lines without the ids: what the operator reads. */
function linesOf(report: unknown) {
  return (
    report as {
      rows: Array<{
        line: number;
        outcome: string;
        reference: string | null;
        message: string | null;
      }>;
    }
  ).rows.map(({ line, outcome, reference, message }) => ({
    line,
    outcome,
    reference,
    message,
  }));
}

function storedFiles(businessId: string): string[] {
  const dir = path.resolve(
    env.UPLOAD_LOCAL_PATH,
    "spreadsheetImports",
    businessId,
  );

  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe("a durable spreadsheet import", () => {
  it(
    "resumes a run killed mid-file from its cursor, every delivery once and the in-memory report",
    { timeout: 60_000 },
    async () => {
      const sheet = [
        row("Primeira", "DUR-001", "Rota Norte"),
        row("Segunda", "", "Rota Norte"),
        row("Terceira", "DUR-003", "Rota Norte"),
        row("Repetida no arquivo", "DUR-001"),
        row("Quinta", "", "Rota Sul"),
        row("Sexta", "DUR-006", "Rota Sul"),
        row("Sétima", "DUR-007"),
      ];

      const response = await post(csv(sheet));

      expect(response.statusCode).toBe(202);

      const importId = response.json().data.id as string;

      expect(storedFiles(CARRIER)).toContain(`${importId}.csv`);

      // The first run dies at its third commit: that row's transaction is
      // rolled back and nothing more is written; the run never returns.
      let commits = 0;
      const killed = runnerWith(async (job) => {
        try {
          await useCase().runJob({
            ...job,
            checkpoint: async (progress, tx) => {
              if (tx && ++commits === 3) throw new JobLeaseLostError(job.id);

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

      await vi.waitFor(async () => expect(commits).toBeGreaterThanOrEqual(3), {
        timeout: 20_000,
      });

      expect(await prisma.delivery.count({ where: { importId } })).toBe(2);

      // Its lease runs out; another process claims the job.
      await prisma.$executeRaw`
        UPDATE "background_job" SET "leaseExpiresAt" = now() - interval '1 second'
        WHERE "subjectId" = ${importId}
      `;

      const survivor = new JobRunner({
        store: new BackgroundJobRepository(),
        sweepIntervalMs: 60_000,
        owner: () => "survivor",
      });
      registerJobHandlers(survivor);

      expect(await survivor.processBatch()).toBe(1);

      const record = await prisma.import.findUniqueOrThrow({
        where: { id: importId },
      });

      expect(record).toMatchObject({
        status: "COMPLETED",
        imported: 6,
        duplicated: 1,
        invalid: 0,
      });

      const deliveries = await prisma.delivery.findMany({
        where: { importId },
        select: { recipient_name: true },
      });

      expect(deliveries.map((each) => each.recipient_name).sort()).toEqual(
        ["Primeira", "Segunda", "Terceira", "Quinta", "Sexta", "Sétima"].sort(),
      );

      expect(await prisma.route.count({ where: { importId } })).toBe(2);

      const job = await prisma.backgroundJob.findFirstOrThrow({
        where: { subjectId: importId },
      });

      expect(job).toMatchObject({ status: "SUCCEEDED", attempts: 2 });
      expect(storedFiles(CARRIER)).not.toContain(`${importId}.csv`);

      // The same file through the in-memory path, in another company.
      const mirror = await useCase().execute({
        userId: mirrorDispatcher,
        businessId: MIRROR,
        filename: "espelho.csv",
        content: csv(sheet),
        shipperId: MIRROR_SHIPPER,
      });

      expect(linesOf(record.report)).toEqual(linesOf(mirror.report));
      expect(
        (
          record.report as { routes: Array<{ name: string; stops: number }> }
        ).routes.map(({ name, stops }) => ({ name, stops })),
      ).toEqual(
        mirror.report.routes.map(({ name, stops }) => ({ name, stops })),
      );
    },
  );

  it("refuses an upload past the company's cap with 429 IMPORT_BUSY, leaving nothing behind", async () => {
    const before = await prisma.import.count({
      where: { businessId: CARRIER },
    });
    const files = storedFiles(CARRIER);
    const queued = env.IMPORT_QUEUED_PER_TENANT;

    env.IMPORT_QUEUED_PER_TENANT = 0;

    // One import of the company already waiting: the cap of 1 is taken.
    await prisma.backgroundJob.create({
      data: {
        kind: "SPREADSHEET_IMPORT",
        businessId: CARRIER,
        subjectId: randomUUID(),
        payload: {},
        availableAt: new Date(Date.now() + 3_600_000),
      },
    });

    try {
      const response = await post(csv([row("Recusada", "DUR-100")]), busyToken);

      expect(response.statusCode).toBe(429);
      expect(response.json().code).toBe("IMPORT_BUSY");
      expect(response.headers["retry-after"]).toBe("30");
      expect(
        await prisma.import.count({ where: { businessId: CARRIER } }),
      ).toBe(before);
      expect(storedFiles(CARRIER)).toEqual(files);
    } finally {
      env.IMPORT_QUEUED_PER_TENANT = queued;
      await prisma.backgroundJob.deleteMany({
        where: { businessId: CARRIER, status: "PENDING" },
      });
    }
  });

  it("is left alone by the abandoned-import sweep while its job lives", async () => {
    const record = await prisma.import.create({
      data: {
        source: "SPREADSHEET",
        status: "IN_PROGRESS",
        filename: "na-fila.csv",
        report: {},
        businessId: CARRIER,
        performedById: dispatcher,
        updated_at: new Date(Date.now() - 3_600_000),
      },
    });
    const job = await prisma.backgroundJob.create({
      data: {
        kind: "SPREADSHEET_IMPORT",
        businessId: CARRIER,
        subjectId: record.id,
        payload: {},
        availableAt: new Date(Date.now() + 3_600_000),
      },
    });

    // updated_at is the heartbeat: back-dated past the sweep's window.
    await prisma.$executeRaw`
      UPDATE "import" SET "updated_at" = now() - interval '1 hour'
      WHERE "id" = ${record.id}
    `;

    const repository = new ImportRepository();
    const staleBefore = new Date(Date.now() - 15 * 60_000);

    await repository.closeAbandonedImports(staleBefore);

    expect(
      (await prisma.import.findUniqueOrThrow({ where: { id: record.id } }))
        .status,
    ).toBe("IN_PROGRESS");

    await prisma.backgroundJob.update({
      where: { id: job.id },
      data: { status: "FAILED", finished_at: new Date() },
    });

    await repository.closeAbandonedImports(staleBefore);

    expect(
      (await prisma.import.findUniqueOrThrow({ where: { id: record.id } }))
        .status,
    ).toBe("COMPLETED");
  });

  it("closes the record when its job fails for good, and keeps the file", async () => {
    const response = await post(csv([row("Sem arquivo", "DUR-200")]));
    const importId = response.json().data.id as string;
    const job = await prisma.backgroundJob.findFirstOrThrow({
      where: { subjectId: importId },
    });
    const objectKey = (job.payload as { objectKey: string }).objectKey;

    // The stored file vanished: no attempt can read it.
    await new UploadService().tryDeleteFile(objectKey);

    const runner = new JobRunner({
      store: new BackgroundJobRepository(),
      sweepIntervalMs: 60_000,
      owner: () => "failing",
    });
    registerJobHandlers(runner);

    await runner.processBatch();

    expect(
      await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).toMatchObject({ status: "FAILED", attempts: 1 });

    const record = await prisma.import.findUniqueOrThrow({
      where: { id: importId },
    });

    expect(record.status).toBe("COMPLETED");
    expect(linesOf(record.report)).toEqual([
      expect.objectContaining({
        line: 1,
        outcome: "invalid",
        message: expect.stringMatching(/falha do servidor/),
      }),
    ]);
  });

  it("releases the stored files an hour after a success and seven days after a failure", async () => {
    const uploads = new UploadService();
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;

    const stored = async (
      status: "SUCCEEDED" | "FAILED",
      finishedAgoMs: number,
    ) => {
      const id = randomUUID();
      const objectKey = `spreadsheetImports/${CARRIER}/${id}.csv`;

      await uploads.putObject(objectKey, Buffer.from("a;b"), "text/csv");

      return prisma.backgroundJob.create({
        data: {
          kind: "SPREADSHEET_IMPORT",
          businessId: CARRIER,
          subjectId: id,
          status,
          payload: { importId: id, objectKey },
          finished_at: new Date(Date.now() - finishedAgoMs),
        },
      });
    };

    const succeeded = await stored("SUCCEEDED", 2 * hour);
    const fresh = await stored("SUCCEEDED", 10 * 60_000);
    const failedOld = await stored("FAILED", 8 * day);
    const failedNew = await stored("FAILED", day);

    await releaseImportObjects();

    const released = (id: string) =>
      prisma.backgroundJob
        .findUniqueOrThrow({ where: { id } })
        .then(
          (job) =>
            (job.payload as { objectReleasedAt?: string }).objectReleasedAt !==
            undefined,
        );

    expect(await released(succeeded.id)).toBe(true);
    expect(await released(failedOld.id)).toBe(true);
    expect(await released(fresh.id)).toBe(false);
    expect(await released(failedNew.id)).toBe(false);

    const files = storedFiles(CARRIER);

    expect(files).not.toContain(`${succeeded.subjectId}.csv`);
    expect(files).not.toContain(`${failedOld.subjectId}.csv`);
    expect(files).toContain(`${failedNew.subjectId}.csv`);
  });
});
