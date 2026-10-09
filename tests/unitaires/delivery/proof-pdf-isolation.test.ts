import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

import { buildProofDocumentModel } from "@/shared/delivery/proof-document";

import { GetProofDocumentUseCase } from "@/modules/delivery/usecases/get-proof-document/get-proof-document-usecase";
import { InMemoryProofDocumentRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-document-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { ProofDocumentSource } from "@/shared/delivery/proof-document";
import type { User } from "@/modules/user/dtos/user-dto";
import { noLocationProviders, unsignedSigning } from "../../support/proof-services";

/**
 * Rendering a receipt PDF must not freeze the replica that serves it.
 *
 * The render runs pdfkit, a QR encoder and — for an RGBA receipt photo — a
 * full synchronous inflate (the ST-01 integrity gate) followed by pdfkit
 * splitting the alpha channel and deflating both halves synchronously. All of
 * that used to run on the request's own event loop: one large PNG held every
 * HTTP request and socket on the replica for the better part of a second, and
 * `?regenerate=true` made it repeatable on demand (today by anyone who can
 * write deliveries; it was anyone who could read one).
 *
 * The render now happens on a worker thread. What this measures is the one
 * thing that matters to everybody else on the replica: the longest stretch
 * the main event loop could not run anything.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const USER = "018f0000-0000-7000-8000-0000000000a1";
const DELIVERY = "018f0000-0000-7000-8000-0000000000e1";

/** A deterministic, incompressible RGBA PNG: the worst case for the render. */
function heavyPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA

  const rowLength = 1 + width * 4;
  const raw = Buffer.alloc(rowLength * height);

  // xorshift32: noise the encoder cannot shrink, the same bytes every run.
  let state = 0x2545f491;

  for (let row = 0; row < height; row += 1) {
    raw[row * rowLength] = 0; // filter: none

    for (let index = 1; index < rowLength; index += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      raw[row * rowLength + index] = state & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function source(): ProofDocumentSource {
  return {
    delivery: {
      id: DELIVERY,
      code: "PED-4471",
      status: "DELIVERED",
      invoice_key: "3".repeat(44),
      invoice_number: "12345",
      recipient_name: "Padaria Central Ltda",
      recipient_document: "11222333000181",
      street: "Praça da Sé",
      address_number: "100",
      complement: null,
      neighborhood: "Sé",
      city: "São Paulo",
      uf: "SP",
      cep: "01001000",
      delivered_at: new Date("2026-09-16T13:30:00.000Z"),
      received_by: "Maria Souza",
      shipper: { name: "Distribuidora Norte", cnpj: "11222333000199" },
    },
    business: {
      corporate_reason: "Transportes Silva Ltda",
      fantasy_name: "Silva Log",
      cnpj: "11222333000166",
    },
    driver: { name: "João Motorista", cpf: "12345678900" },
    route: { code: 42, name: "Zona Sul — manhã" },
    proof: {
      created_at: new Date("2026-09-16T13:30:00.000Z"),
      latitude: -23.550519,
      longitude: -46.633308,
      device: "Moto G84 (Android 14)",
      photoKey: `deliveryPhotos/${BUSINESS}/1-canhoto-aaaa0001.png`,
      signatureKey: null,
    },
    occurrences: [],
  } as ProofDocumentSource;
}

/** The longest gap between 5 ms ticks while `work` runs. */
async function longestStall(work: () => Promise<unknown>): Promise<number> {
  let last = performance.now();
  let worst = 0;

  const timer = setInterval(() => {
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now;
  }, 5);

  try {
    await work();
  } finally {
    clearInterval(timer);
  }

  return worst;
}

// About 5 MB, the size limit of a delivery photo.
const PHOTO = heavyPng(1120, 1120);

/** Measured regenerations; the verdict uses the least-stalled one. */
const STALL_TRIALS = 3;

afterAll(async () => {
  const renderer = await import("@/shared/services/proof-pdf-renderer").catch(
    () => null,
  );

  await renderer?.shutdownProofRenderer?.();
});

describe("generating a receipt", () => {
  it("keeps the replica's event loop free while a large photo is rendered", async () => {
    const users = new InMemoryUserRepository();
    users.user.push({ id: USER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User);

    const documents = new InMemoryProofDocumentRepository();
    documents.addSource(BUSINESS, source());

    const stored: Buffer[] = [];

    const uploads = {
      readObject: async () => PHOTO,
      putObject: async (_key: string, body: Buffer) => {
        stored.push(body);
      },
      getFileUrl: async () => "https://bucket.exemplo/proof.pdf",
    };

    const useCase = new GetProofDocumentUseCase(
      users,
      documents,
      uploads as never,
      unsignedSigning(),
      noLocationProviders(),
    );

    // A first render warms up whatever is lazy (module loading, the worker)
    // so the measurement is of rendering, not of starting.
    await useCase.execute({ userId: USER, businessId: BUSINESS, deliveryId: DELIVERY });

    // The best of a few renders, not one. A render on this loop blocks it in
    // EVERY trial. A gap the OS scheduler adds does not: with the rest of the
    // suite saturating the cores, this thread was measured descheduled for
    // 73 ms once in a render that was off-thread, while alone it stays far
    // below the bar. The minimum keeps the first and drops the second.
    const stalls: number[] = [];

    for (let trial = 0; trial < STALL_TRIALS; trial += 1) {
      stalls.push(
        await longestStall(() =>
          useCase.execute({
            userId: USER,
            businessId: BUSINESS,
            deliveryId: DELIVERY,
            regenerate: true,
          }),
        ),
      );
    }

    const stall = Math.min(...stalls);

    // In-process this measured ~110 ms on a fast desktop — pdfkit splitting
    // the alpha channel pixel by pixel — and a production vCPU is slower.
    // Off-thread, what is left on this loop is copying the bytes across.
    expect(
      stall,
      `event loop stalled for ${stalls.map((ms) => Math.round(ms)).join(" / ")} ms`,
    ).toBeLessThan(50);

    // Still the same document: the hash recorded is of the bytes stored.
    const saved = documents.documents[0];
    const last = stored[stored.length - 1];

    expect(last.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(saved.sha256).toBe(createHash("sha256").update(last).digest("hex"));
  }, 60_000);
});

describe("the render worker", () => {
  const model = () =>
    buildProofDocumentModel(source(), {
      verificationBaseUrl: "https://app.exemplo",
      verificationToken: "9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e",
    });

  it("gives up on a render that takes too long, and the next one still works", async () => {
    const { renderProofPdfOffThread } = await import(
      "@/shared/services/proof-pdf-renderer"
    );

    await expect(
      renderProofPdfOffThread(
        model(),
        { photo: PHOTO, signature: null },
        { timeoutMs: 1 },
      ),
    ).rejects.toMatchObject({ statusCode: 503, code: "PROOF_RENDER_TIMEOUT" });

    const rendered = await renderProofPdfOffThread(model(), {
      photo: null,
      signature: null,
    });

    expect(rendered.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  }, 60_000);

  it("refuses more work than it can queue, instead of queueing without bound", async () => {
    const { renderProofPdfOffThread, MAX_PENDING_RENDERS } = await import(
      "@/shared/services/proof-pdf-renderer"
    );

    const images = { photo: null, signature: null };

    const accepted = Array.from({ length: MAX_PENDING_RENDERS }, () =>
      renderProofPdfOffThread(model(), images),
    );

    await expect(renderProofPdfOffThread(model(), images)).rejects.toMatchObject({
      statusCode: 503,
      code: "PROOF_RENDER_BUSY",
    });

    for (const render of await Promise.all(accepted)) {
      expect(render.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    }
  }, 60_000);

  it("renders the same bytes as the in-process renderer", async () => {
    const { renderProofPdfOffThread } = await import(
      "@/shared/services/proof-pdf-renderer"
    );
    const { renderProofPdf } = await import("@/shared/services/proof-pdf-service");

    const images = { photo: null, signature: null };

    const [inProcess, offThread] = await Promise.all([
      renderProofPdf(model(), images),
      renderProofPdfOffThread(model(), images),
    ]);

    // The PDF carries its creation date, so the bytes are compared by size
    // and structure, not by hash.
    expect(offThread.bytes.length).toBeGreaterThan(1000);
    expect(Math.abs(offThread.bytes.length - inProcess.bytes.length)).toBeLessThan(64);
    expect(offThread.sha256).toBe(
      createHash("sha256").update(offThread.bytes).digest("hex"),
    );
  }, 60_000);

  it("is built as its own entry, where the renderer looks for it in production", () => {
    const tsup = readFileSync(resolve(__dirname, "../../../tsup.config.ts"), "utf8");

    expect(tsup).toMatch(
      /"proof-pdf-worker":\s*"\.\/src\/shared\/services\/proof-pdf-worker\.ts"/,
    );
  });
});
