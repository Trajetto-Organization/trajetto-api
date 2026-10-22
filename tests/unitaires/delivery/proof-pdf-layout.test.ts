import { describe, expect, it } from "vitest";

import { deflateSync, inflateSync } from "node:zlib";

import {
  buildProofDocumentModel,
  type ProofDocumentModel,
  type ProofDocumentSource,
  type ProofSigningIntent,
} from "@/shared/delivery/proof-document";

import type { ProofMapImage } from "@/shared/services/proof-location/map-tiles";
import {
  PAGE_MARGIN,
  renderProofPdf,
} from "@/shared/services/proof-pdf-service";

/**
 * The validated model's layout, read back from the rendered bytes (decision
 * 14.8): which text is drawn, in what order, where, in which colour.
 *
 * pdfkit writes each line as `BT 1 0 0 1 x y Tm /Fn size Tf [<hex> …] TJ ET`,
 * with y measured from the bottom of the page, preceded by its fill colour.
 */
interface Run {
  page: number;
  x: number;
  y: number;
  size: number;
  text: string;
  /** The fill colour in force (r g b, 0–1), when one was set. */
  color: string | null;
}

/** WinAnsi → Unicode for the few code points that differ from Latin-1. */
const WIN_ANSI: Record<number, string> = { 0x96: "–", 0x97: "—" };

function decode(hex: string): string {
  return [...Buffer.from(hex, "hex")]
    .map((byte) => WIN_ANSI[byte] ?? String.fromCharCode(byte))
    .join("");
}

/** The page content streams, inflated, in page order. */
function pageContents(bytes: Buffer): string[] {
  const raw = bytes.toString("latin1");
  const pages: string[] = [];

  for (const match of raw.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) {
    let content: string;

    try {
      content = inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      continue;
    }

    // Images are FlateDecode streams too; only page content has text.
    if (/\bBT\b[\s\S]*?\bET\b/.test(content)) pages.push(content);
  }

  return pages;
}

/** Every line of text the PDF draws, page by page, in drawing order. */
function textRuns(bytes: Buffer): Run[] {
  const runs: Run[] = [];

  pageContents(bytes).forEach((content, index) => {
    let color: string | null = null;

    for (const token of content.matchAll(
      /([\d.]+ [\d.]+ [\d.]+) scn|BT\s+1 0 0 1 ([\d.-]+) ([\d.-]+) Tm\s+\/\S+ ([\d.]+) Tf([\s\S]*?)ET/g,
    )) {
      if (token[1]) {
        color = token[1];
        continue;
      }

      const text = [...token[5].matchAll(/<([0-9a-f]*)>/gi)]
        .map((hex) => decode(hex[1]))
        .join("");

      runs.push({
        page: index + 1,
        x: Number(token[2]),
        y: Number(token[3]),
        size: Number(token[4]),
        text,
        color,
      });
    }
  });

  return runs;
}

const pageCount = (bytes: Buffer): number =>
  (bytes.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length;

/** An RGB PNG of `width`×`height`, a flat colour: a stand-in receipt photo. */
function png(
  width: number,
  height: number,
  rgb: [number, number, number],
): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (data: Buffer) => {
    let c = 0xffffffff;
    for (const byte of data) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, sum]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;

  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(width * 3).map((_, i) => rgb[i % 3]),
  ]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function source(): ProofDocumentSource {
  return {
    delivery: {
      id: "018f0000-0000-7000-8000-0000000000e1",
      code: "PED-4471",
      status: "DELIVERED",
      invoice_key: "3226093135803500012055002000045515100045515".padEnd(
        44,
        "0",
      ),
      invoice_number: "45515",
      recipient_name: "Supermercado Cabral Ltda",
      recipient_document: "30970502000106",
      street: "Rua Alberto de Oliveira Santos",
      address_number: "494",
      complement: null,
      neighborhood: "Soteco",
      city: "Vila Velha",
      uf: "ES",
      cep: "29106100",
      delivered_at: new Date("2026-09-30T16:30:26.000Z"),
      received_by: "Maria Souza",
      shipper: {
        name: "Multipla",
        corporate_reason: "Multipla Distribuidora de Alimentos Ltda",
        cnpj: null,
      },
    },
    business: {
      corporate_reason: "Transportes Silva Ltda",
      cnpj: "11222333000166",
      timezone: "America/Sao_Paulo",
    },
    driver: { name: "Rogerio Viana Bezerra", cpf: "09797417778" },
    route: { code: 5696, name: null },
    proof: {
      created_at: new Date("2026-09-30T16:30:26.000Z"),
      photo_taken_at: new Date("2026-09-30T16:30:08.000Z"),
      latitude: -20.3502181,
      longitude: -40.3038332,
      device_id: "23be03c084165505",
      photoKey: "delivery/photo.png",
      signatureKey: "delivery/signature.png",
      gps_address: {
        line: "Rua Alberto de Oliveira Santos, 117",
        district: "Soteco",
        city: "Vila Velha",
        state: "Espírito Santo",
        cep: "29106100",
      },
      gps_address_source: "PROVIDER",
    },
    deliveredTypeName: "Entrega normal",
    occurrences: [],
  };
}

const SIGNED: ProofSigningIntent = {
  status: "SIGNED",
  signer: { name: "TRAJETTO SISTEMAS LTDA", cnpj: "11222333000181" },
};

const model = (signing: ProofSigningIntent = SIGNED): ProofDocumentModel =>
  buildProofDocumentModel(source(), {
    verificationBaseUrl: "https://app.trajetto.com.br",
    verificationToken:
      "9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e",
    signing,
  });

function map(): ProofMapImage {
  const tile = png(256, 256, [200, 220, 190]);

  return {
    width: 400,
    height: 170,
    tiles: [0, 1, 2].flatMap((column) =>
      [0, 1].map((row) => ({
        bytes: tile,
        left: column * 256 - 150,
        top: row * 256 - 180,
      })),
    ),
    marker: { x: 200, y: 85 },
    attribution: "© OpenStreetMap",
  };
}

/** A typical receipt: wide photo, on-screen signature and the map. */
async function typical(signing: ProofSigningIntent = SIGNED) {
  return renderProofPdf(model(signing), {
    photo: png(1600, 600, [235, 235, 225]),
    signature: png(300, 100, [255, 255, 255]),
    map: map(),
  });
}

describe("the receipt in the model's layout", () => {
  it("keeps a typical receipt (photo, signature and map) on one page", async () => {
    expect(pageCount((await typical()).bytes)).toBe(1);
    expect(pageCount((await typical({ status: "UNSIGNED" })).bytes)).toBe(1);
  }, 30_000);

  it("draws the sections top to bottom in the model's order, titles at the margin", async () => {
    const runs = textRuns((await typical()).bytes);

    const titles = [
      "Documento da entrega:",
      "Dados da entrega:",
      "Protocolo do documento:",
      "Entregador",
      "Comprovante digitalizado:",
      "Autenticação:",
    ];

    const found = titles.map((title) => runs.find((run) => run.text === title));

    for (const [index, run] of found.entries()) {
      expect(run, titles[index]).toBeDefined();
      expect(run!.x, titles[index]).toBe(PAGE_MARGIN);
    }

    // One page; PDF y grows upwards: each title is below the previous one.
    expect(new Set(found.map((run) => run!.page))).toEqual(new Set([1]));
    const ys = found.map((run) => run!.y);
    expect([...ys].sort((a, b) => b - a)).toEqual(ys);

    // The header is above all of them, centred.
    const header = runs.find(
      (run) => run.text === "Certificado Digital da Comprovação de Entrega",
    );
    expect(header!.y).toBeGreaterThan(ys[0]);
    expect(header!.x).toBeGreaterThan(PAGE_MARGIN + 50);
  }, 30_000);

  it("prints each field as 'Label: value' on one row, side by side where the model has two", async () => {
    const runs = textRuns((await typical()).bytes);

    const pair = (label: string, value: string) => {
      const labelRun = runs.find((run) => run.text === `${label}: `);
      const valueRun = runs.find(
        (run) =>
          run.text === value &&
          labelRun &&
          run.y === labelRun.y &&
          run.x > labelRun.x,
      );

      expect(labelRun, label).toBeDefined();
      expect(valueRun, `${label} → ${value}`).toBeDefined();

      return { label: labelRun!, value: valueRun! };
    };

    const number = pair("Nº do documento", "45515");
    const kind = pair("Tipo", "NFe");

    expect(kind.label.y).toBe(number.label.y);
    expect(kind.label.x).toBeGreaterThanOrEqual(PAGE_MARGIN + 160);

    pair("Nº da rota", "5696");
    pair("Razão Social Emitente", "Multipla Distribuidora de Alimentos Ltda");
    pair("Data", "2026-09-30");
    pair("Hora", "13:30:26 (horário de Brasília, UTC-3)");
    pair("Ocorrência", "Entrega normal");
    pair("Latitude", "-20.3502181");
    pair("Longitude", "-40.3038332");
    pair("Identificação do Celular", "23be03c084165505");

    const city = pair("Município", "Vila Velha");
    expect(pair("UF", "ES").label.y).toBe(city.label.y);
    expect(pair("CEP", "29106100").label.y).toBe(city.label.y);
  }, 30_000);

  it("writes the stamp in yellow, on one line, between the photo title and the authentication", async () => {
    const runs = textRuns((await typical()).bytes);

    const stamp = runs.find((run) =>
      run.text.startsWith("Trajetto - 30/09/2026 13:30:08"),
    );
    const photoTitle = runs.find(
      (run) => run.text === "Comprovante digitalizado:",
    )!;
    const auth = runs.find((run) => run.text === "Autenticação:")!;

    expect(stamp).toBeDefined();
    expect(stamp!.text).toBe(
      "Trajetto - 30/09/2026 13:30:08  -20,3502, -40,3038  ROGERIO VIANA BEZERRA  NFe 45515",
    );
    expect(stamp!.size).toBe(7.5);
    // #FFD400
    expect(
      stamp!.color!.split(" ").map((part) => Number(Number(part).toFixed(3))),
    ).toEqual([1, 0.831, 0]);
    expect(stamp!.y).toBeLessThan(photoTitle.y);
    expect(stamp!.y).toBeGreaterThan(auth.y);
  }, 30_000);

  it("puts the GPS address under the coordinates, the CEP after it, and the map credit", async () => {
    const runs = textRuns((await typical()).bytes);

    const latitude = runs.find((run) => run.text === "Latitude: ")!;
    const address = runs.find((run) =>
      run.text.startsWith("Rua Alberto de Oliveira Santos, 117"),
    )!;
    const cep = runs.find((run) => run.text === "29106-100")!;

    expect(address.y).toBeLessThan(latitude.y);
    expect(cep.y).toBeLessThan(address.y);
    expect(runs.some((run) => run.text === "© OpenStreetMap")).toBe(true);
  }, 30_000);

  it("draws no map credit, and no empty frame, without a map", async () => {
    const rendered = await renderProofPdf(model(), {
      photo: null,
      signature: null,
      map: null,
    });
    const runs = textRuns(rendered.bytes);

    expect(runs.some((run) => run.text.includes("OpenStreetMap"))).toBe(false);
    // The photo slot says why it is empty instead.
    expect(
      runs.some((run) => run.text === "Nenhuma foto foi registrada."),
    ).toBe(false);
    expect(
      runs.some(
        (run) =>
          run.text ===
          "A imagem do canhoto não está mais disponível no armazenamento.",
      ),
    ).toBe(true);
  }, 30_000);

  it("draws the Trajetto watermark first, behind everything, at low opacity", async () => {
    const [first] = pageContents((await typical()).bytes);

    const image = first.search(/\/I\d+ Do/);
    const text = first.search(/\bBT\b/);

    expect(image).toBeGreaterThanOrEqual(0);
    expect(image).toBeLessThan(text);

    // The opacity state used around it.
    expect((await typical()).bytes.toString("latin1")).toMatch(/\/ca 0\.08/);
  }, 30_000);

  it("says, when unsigned, that it is unsigned — and never mentions the ITI", async () => {
    const runs = textRuns((await typical({ status: "UNSIGNED" })).bytes);
    const all = runs.map((run) => run.text).join("\n");

    expect(runs[0].text).toBe("Comprovante de Entrega");
    expect(all).toContain("Este documento não foi assinado digitalmente.");
    expect(all).not.toContain("validar.iti");
    expect(all).not.toContain("Assina-se com Certificado Digital");
    expect(all).not.toContain("validade jurídica conforme");
  }, 30_000);

  it("keeps a long value from running into the next row", async () => {
    const long = model();

    long.sections.document.blocks[1].lines[0][0].value =
      "Multipla Distribuidora de Alimentos, Bebidas e Produtos de Limpeza do Espírito Santo e da Região Metropolitana da Grande Vitória Ltda";

    const runs = textRuns(
      (await renderProofPdf(long, { photo: null, signature: null })).bytes,
    );

    const name = runs.filter(
      (run) => run.text.startsWith("Multipla") || run.text.includes("Vitória"),
    );
    const cnpj = runs.filter((run) => run.text === "CNPJ: ");

    expect(name.length).toBeGreaterThanOrEqual(2);
    // The CNPJ row of that block starts below the wrapped value's last line.
    const lastNameLine = Math.min(...name.map((run) => run.y));
    expect(cnpj.some((run) => run.y < lastNameLine - 8)).toBe(true);
  }, 30_000);
});
