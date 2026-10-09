import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  LocalOcrHttpError,
  LocalOcrReader,
  UnsupportedReadingError,
} from "@/shared/ai/local/local-ocr-reader";
import { OCR_RULES_VERSION } from "@/shared/ai/local/ocr-readings";
import { PaidInvalidResponseError } from "@/shared/ai/reader-errors";

/**
 * The local OCR reader against an in-memory HTTP server that speaks the
 * trajetto-ai contract (infra/ai-ocr/server.py): what it sends, how it reads
 * the answer, and what each failure means for the pipeline (ADR 0010 §3.2).
 */

const TOKEN = "k".repeat(48);
const PHOTO = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0, 255]);

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: Buffer;
}

let server: http.Server;
let baseUrl: string;
let seen: Seen[] = [];
let respond: (seen: Seen, res: http.ServerResponse) => void;

const box = (x: number, y: number, w: number, h: number) => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

const RECEIPT_LINES = [
  { text: "RECEBEMOS DE DISTRIBUIDORA LTDA OS PRODUTOS", score: 0.99, box: box(100, 100, 900, 20) },
  { text: "N° 000.045.181", score: 0.97, box: box(1060, 150, 160, 24) },
  { text: "DATA DE RECEBIMENTO", score: 0.98, box: box(100, 160, 150, 14) },
  { text: "27/09/2026", score: 0.95, box: box(110, 200, 160, 40) },
];

function ok(lines: unknown[], profile: string) {
  return (_seen: Seen, res: http.ServerResponse) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        lines,
        width: 1600,
        height: 1200,
        inferMs: 700,
        queueMs: 0,
        engine: "rapidocr",
        engineVersion: "3.9.2",
        profile,
      }),
    );
  };
}

function status(code: number, error: string) {
  return (_seen: Seen, res: http.ServerResponse) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };
}

function reader(overrides: Partial<ConstructorParameters<typeof LocalOcrReader>[0]> = {}) {
  return new LocalOcrReader({
    url: `${baseUrl}/`,
    token: TOKEN,
    timeoutMs: 2_000,
    maxConcurrency: 1,
    ...overrides,
  });
}

const image = { bytes: PHOTO, mediaType: "image/jpeg" as const };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: req.headers.authorization,
        contentType: req.headers["content-type"],
        body: Buffer.concat(chunks),
      };
      seen.push(entry);
      respond(entry, res);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  seen = [];
  respond = ok(RECEIPT_LINES, "receipt");
});

describe("what the reader sends", () => {
  it("posts the photo as raw bytes with the token, to the receipt profile for a proof", async () => {
    await reader().read({ kind: "proof" }, image);

    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe("/v1/read?profile=receipt");
    expect(seen[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].contentType).toBe("image/jpeg");
    // Bytes, not base64 in JSON (33% more and one more parse).
    expect(seen[0].body.equals(PHOTO)).toBe(true);
  });

  it("reads an odometer with the digits profile — the one without the direction classifier", async () => {
    respond = ok([{ text: "84312", score: 0.99, box: box(0, 0, 100, 40) }], "digits");

    await reader().read({ kind: "odometer", subject: "o odômetro" }, image);

    expect(seen[0].url).toBe("/v1/read?profile=digits");
  });

  it("refuses the kinds OCR does not read, without calling the service", async () => {
    for (const kind of ["fuel_level", "condition", "working"] as const) {
      await expect(
        reader().read({ kind, subject: "o item" }, image),
      ).rejects.toBeInstanceOf(UnsupportedReadingError);
    }

    expect(seen).toHaveLength(0);
  });
});

describe("what it makes of the answer", () => {
  it("turns the lines into the product's answer, with the rules' version on the usage", async () => {
    const { parsed, usage } = await reader().read({ kind: "proof" }, image);

    expect(parsed).toMatchObject({
      e_canhoto: "sim",
      numero_documento_lido: "000045181",
      data_recebimento_lida: "27/09/2026",
      tem_assinatura: "nao_sei",
      assinatura_avaliada: false,
      nome_recebedor_lido: null,
    });
    expect(usage).toMatchObject({
      provider: "local",
      model: `rapidocr-3.9.2/receipt/rules-v${OCR_RULES_VERSION}`,
      inputTokens: null,
      outputTokens: null,
    });
    expect(usage.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("answers an odometer with fraud declared not assessed", async () => {
    respond = ok([{ text: "84312", score: 0.99, box: box(0, 0, 100, 40) }], "digits");

    const { parsed } = await reader().read({ kind: "odometer", subject: "o odômetro" }, image);

    expect(parsed).toMatchObject({ valor_lido: 84312, legivel: true, fraude_avaliada: false });
  });

  it("treats a 200 outside the contract as an invalid answer, never as a verdict", async () => {
    respond = (_seen, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ lines: [{ text: 1 }] }));
    };

    await expect(reader().read({ kind: "proof" }, image)).rejects.toBeInstanceOf(
      PaidInvalidResponseError,
    );
  });
});

describe("what each failure means for the pipeline", () => {
  it.each([
    [503, "busy", "busy"],
    [401, "unauthorized", "unauthorized"],
    [400, "invalid_image", "permanent"],
    [413, "too_large", "permanent"],
    [500, "engine_error", "retryable"],
    [502, "bad_gateway", "retryable"],
    [504, "gateway_timeout", "retryable"],
    [404, "not_found", "retryable"],
  ] as const)("HTTP %i is %s -> %s", async (code, error, kind) => {
    respond = status(code, error);
    const subject = reader();

    const failure = await subject.read({ kind: "proof" }, image).catch((thrown) => thrown);

    expect(failure).toBeInstanceOf(LocalOcrHttpError);
    expect(subject.classifyError(failure)).toBe(kind);
    // The token never rides along in an error that reaches a log.
    expect(String(failure.message)).not.toContain(TOKEN);
  });

  it("a refused connection is retryable (five in a row open the circuit)", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));

    const subject = reader({ url: `http://127.0.0.1:${port}` });
    const failure = await subject.read({ kind: "proof" }, image).catch((thrown) => thrown);

    expect(failure).toBeInstanceOf(Error);
    expect(subject.classifyError(failure)).toBe("retryable");
    expect(String(failure.message)).not.toContain(TOKEN);
  });

  it("a service that never answers is cut at the timeout, and is retryable", async () => {
    respond = () => {
      // Never answers.
    };

    const subject = reader({ timeoutMs: 200 });
    const startedAt = Date.now();
    const failure = await subject.read({ kind: "proof" }, image).catch((thrown) => thrown);

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(["TimeoutError", "AbortError"]).toContain(failure.name);
    expect(subject.classifyError(failure)).toBe("retryable");
  });

  it("an unsupported kind asked by mistake is permanent: the unit is given back", () => {
    expect(reader().classifyError(new UnsupportedReadingError("condition"))).toBe("permanent");
  });
});

describe("its declared budget", () => {
  it("takes no client retry and reads only the receipt and the odometer", () => {
    const subject = reader({ maxConcurrency: 2, timeoutMs: 15_000 });

    expect(subject.maxRetries).toBe(0);
    expect(subject.timeoutMs).toBe(15_000);
    expect(subject.maxConcurrency).toBe(2);
    expect(subject.isConfigured()).toBe(true);
    expect(["proof", "odometer", "fuel_level", "condition", "working"].map((kind) => subject.supports(kind as never))).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
