import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateOdometerReading, readProofExtraction } from "@/shared/ai/ai-rules";
import { PROOF_INPUT_VERSION } from "@/shared/ai/ai-types";
import { LocalOcrHttpError, LocalOcrReader } from "@/shared/ai/local/local-ocr-reader";
import { assessProof } from "@/shared/ai/proof-criteria";

/**
 * OPT-IN contract test against the REAL trajetto-ai container (ADR 0010,
 * docs/desenho/ia-local-implementacao.md P8.1). Off by default: it needs
 * Docker and ~1 GiB.
 *
 *   AI_LOCAL_E2E=1 npx vitest run tests/ai-local
 *
 * Builds infra/ai-ocr (or uses AI_LOCAL_E2E_IMAGE), runs it as production
 * does — read-only, no capabilities, 2 CPUs, 1 GiB — with AI_MAX_QUEUE=0 so
 * a second concurrent read is turned away, and passes six synthetic photos
 * of the benchmark through the product's LocalOcrReader and rules.
 */
const ENABLED = process.env.AI_LOCAL_E2E === "1";

const FIXTURES = path.join(__dirname, "fixtures");
const CONTEXT = path.resolve(__dirname, "../../infra/ai-ocr");
const NAME = `trajetto-ai-e2e-${process.pid}`;
const TOKEN = randomBytes(24).toString("hex");

const photo = (name: string) => ({
  bytes: fs.readFileSync(path.join(FIXTURES, name)),
  mediaType: "image/jpeg" as const,
});

const PROOF_INPUT = {
  photoPath: "p.jpg",
  signaturePath: null,
  expectedDocument: "45181",
  expectedRecipient: "Mercado Boa Vista Ltda",
  provenOn: "2026-09-27",
  inputVersion: PROOF_INPUT_VERSION,
};

/** P01 padded to 3 MB with trailing bytes: past Docker's proxy buffer (the decoder may or may not accept the tail). */
const largePhoto = () => {
  const head = fs.readFileSync(path.join(FIXTURES, "P01.jpg"));
  const bytes = Buffer.concat([head, randomBytes(3 * 1024 * 1024)]);

  return { bytes, mediaType: "image/jpeg" as const };
};

let baseUrl = "";
let reader: LocalOcrReader;

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function waitForHealth(timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const deadline = Date.now() + timeoutMs;
  let last: { status: number; body: unknown } = { status: 0, body: null };

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      last = { status: response.status, body: await response.json() };
      if (response.status === 200) return last;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return last;
}

describe.skipIf(!ENABLED)("the trajetto-ai container, through the product's reader and rules", () => {
  beforeAll(async () => {
    const image = process.env.AI_LOCAL_E2E_IMAGE || "trajetto-ai:e2e";

    if (!process.env.AI_LOCAL_E2E_IMAGE) {
      docker(["build", "-t", image, CONTEXT]);
    }

    docker([
      "run", "-d", "--name", NAME,
      "--read-only", "--tmpfs", "/tmp",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--cpus", "2", "--memory", "1g",
      "-e", `AI_TOKEN=${TOKEN}`, "-e", "OCR_THREADS=2", "-e", "AI_MAX_QUEUE=0",
      "-p", "127.0.0.1::8080",
      image,
    ]);

    const port = docker(["port", NAME, "8080/tcp"]).split("\n")[0].split(":").pop();
    baseUrl = `http://127.0.0.1:${port}`;

    reader = new LocalOcrReader({ url: baseUrl, token: TOKEN, timeoutMs: 15_000, maxConcurrency: 1 });
  }, 600_000);

  afterAll(() => {
    try {
      docker(["rm", "-f", NAME]);
    } catch {
      // Already gone.
    }
  });

  it("answers /health 200 only once both profiles are loaded and warm", async () => {
    const health = await waitForHealth(120_000);

    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({
      ok: true,
      engine: "rapidocr",
      engineVersion: "3.9.2",
      profiles: ["receipt", "digits"],
    });
  }, 130_000);

  it("refuses a wrong token as 'unauthorized'", async () => {
    const wrong = new LocalOcrReader({ url: baseUrl, token: "x".repeat(48), timeoutMs: 15_000, maxConcurrency: 1 });
    const failure = await wrong.read({ kind: "proof" }, photo("P01.jpg")).catch((error) => error);

    expect(failure).toBeInstanceOf(LocalOcrHttpError);
    expect(wrong.classifyError(failure)).toBe("unauthorized");
  });

  // Red before (server.py): a refusal sent over an unread body of a few MB
  // reached undici as a socket reset — a wrong token looked "retryable".
  // Real photos reach 5 MB (MAX_UPLOAD_IMAGE_BYTES); Docker's port proxy
  // buffers small bodies, so only a large one shows it.
  it("refuses a wrong token as 'unauthorized' with a 3 MB photo too", async () => {
    const wrong = new LocalOcrReader({ url: baseUrl, token: "x".repeat(48), timeoutMs: 15_000, maxConcurrency: 1 });

    for (let attempt = 0; attempt < 5; attempt++) {
      const failure = await wrong.read({ kind: "proof" }, largePhoto()).catch((error) => error);

      expect(failure).toBeInstanceOf(LocalOcrHttpError);
      expect(wrong.classifyError(failure)).toBe("unauthorized");
    }
  }, 60_000);

  it.each(["P01.jpg", "P02.jpg"])(
    "%s, a correct receipt: number and date match, signature left for a person",
    async (file) => {
      const { parsed, usage } = await reader.read({ kind: "proof" }, photo(file));
      const reading = readProofExtraction(parsed, PROOF_INPUT);

      expect(usage.provider).toBe("local");
      expect(usage.model).toMatch(/^rapidocr-3\.9\.2\/receipt\/rules-v\d+$/);
      expect(reading.documentMatches).toBe("yes");
      expect(reading.dateVisible).toBe("yes");
      expect(reading.hasSignature).toBe("unknown");
      expect(assessProof(reading).suggestion).toBe("needs_review");
    },
    60_000,
  );

  it("P06, another invoice number on the receipt: 'looks_wrong'", async () => {
    const { parsed } = await reader.read({ kind: "proof" }, photo("P06.jpg"));
    const assessment = assessProof(readProofExtraction(parsed, PROOF_INPUT));

    expect(assessment.suggestion).toBe("looks_wrong");
    expect(assessment.failed).toContain("documentMatches");
  }, 60_000);

  it("O01, an LCD read with the digits profile (no direction classifier): the km matches, without the seal", async () => {
    const { parsed, usage } = await reader.read({ kind: "odometer", subject: "o odômetro" }, photo("O01.jpg"));
    const result = evaluateOdometerReading(parsed, 84312);

    expect(usage.model).toMatch(/\/digits\//);
    expect(parsed.valor_lido).toBe(84312);
    expect(result).toMatchObject({ status: "verified", fraudAssessed: false });
  }, 60_000);

  it("O03, the drum read as 5671 (measured, results-2026-10.md): a mismatch for a person", async () => {
    const { parsed } = await reader.read({ kind: "odometer", subject: "o odômetro" }, photo("O03.jpg"));
    const result = evaluateOdometerReading(parsed, 56719);

    // The pinned engine and models give the same lines: a different value
    // here means the image no longer runs what was measured.
    expect(parsed.valor_lido).toBe(5671);
    expect(result.status).toBe("mismatch");
  }, 60_000);

  it("K11, not an odometer: never 'km confere'", async () => {
    const { parsed } = await reader.read({ kind: "odometer", subject: "o odômetro" }, photo("K11.jpg"));
    const result = evaluateOdometerReading(parsed, 45210);

    expect(result.status).not.toBe("verified");
  }, 60_000);

  it("a second read while one runs (AI_MAX_QUEUE=0) is 'busy', never a failure", async () => {
    const results = await Promise.allSettled([
      reader.read({ kind: "proof" }, photo("P01.jpg")),
      reader.read({ kind: "proof" }, photo("P02.jpg")),
      reader.read({ kind: "proof" }, photo("P06.jpg")),
    ]);

    const refused = results.filter((result) => result.status === "rejected");

    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(refused.length).toBeGreaterThan(0);

    for (const result of refused) {
      expect(reader.classifyError((result as PromiseRejectedResult).reason)).toBe("busy");
    }
  }, 120_000);

  it("a 3 MB photo turned away while one runs is still 'busy', not a reset", async () => {
    const results = await Promise.allSettled([
      reader.read({ kind: "proof" }, photo("P01.jpg")),
      ...Array.from({ length: 4 }, () => reader.read({ kind: "proof" }, largePhoto())),
    ]);

    const refused = results.filter((result) => result.status === "rejected");

    expect(refused.length).toBeGreaterThan(0);

    for (const result of refused) {
      const reason = (result as PromiseRejectedResult).reason;

      // A busy refusal, or the padded body read and refused as an image.
      expect(reason).toBeInstanceOf(LocalOcrHttpError);
      expect(["busy", "permanent"]).toContain(reader.classifyError(reason));
    }

    expect(
      refused.some((result) => reader.classifyError((result as PromiseRejectedResult).reason) === "busy"),
    ).toBe(true);
  }, 120_000);
});
