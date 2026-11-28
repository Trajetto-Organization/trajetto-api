import "reflect-metadata";

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { VerifyProofDocumentUseCase } from "@/modules/delivery/usecases/verify-proof-document/verify-proof-document-usecase";
import { InMemoryProofDocumentRepository } from "@/modules/delivery/repositories/in-memory/in-memory-proof-document-repository";
import { AppError } from "@/shared/errors/AppError";
import { DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";
import type { UploadService } from "@/shared/services/upload-service";

/**
 * The contracts this round changed, held where a client of the OTHER version
 * depends on them (spec §18, both directions of a rolling deploy).
 *
 * - New fields are optional in the document wherever a copy written by the
 *   previous API can still be served: the MASTER overview and the provider
 *   report are shared through Redis, and a required field would fail the
 *   serialisation of that copy (a 500) for the minute the two versions
 *   overlap. The entitlements answer is never cached, so its new breakdown is
 *   required (the web reads it as optional, for the previous API).
 * - Storage that did not answer is a 503 to retry, never `intact: false`:
 *   the public /verificar page reads anything but 404/400 as "try again",
 *   and `intact: false` as a document that is gone.
 * - The web declares the same fields optional, so the previous API's answer
 *   still renders (read from the sibling checkout when it is there, like
 *   client-routes.test.ts).
 * - A driver's vehicle history carries no money from 09/11/2026 (wave 3's
 *   driver view). The web's driver page reads none of it, only fields the
 *   previous API sends too, so that web may go before this API. In the usual
 *   order (API → web) the previous web shows the driver "R$ 0,00" and "N/A"
 *   where the total and the supplier were (no crash, no NaN; a null would
 *   read the same) until the new web serves and the tab reloads.
 *   docs/deploy.md has the order for staging and for production.
 */
type Json = Record<string, any>;

const TOKEN =
  "7b1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e9f1c2a4e6b8d0f3a5c7e9b1d3f5a7c9e";
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const BYTES = Buffer.from("%PDF-1.7 comprovante");

function verifyWith(readObject: UploadService["readObject"]) {
  const documents = new InMemoryProofDocumentRepository();

  documents.addSource(BUSINESS, {
    delivery: {
      id: "018f0000-0000-7000-8000-0000000000e1",
      code: "PED-1",
      status: "DELIVERED",
      invoice_key: null,
      invoice_number: null,
      recipient_name: "Padaria Central Ltda",
      recipient_document: null,
      street: "Rua",
      address_number: null,
      complement: null,
      neighborhood: null,
      city: "Manaus",
      uf: "AM",
      cep: null,
      delivered_at: new Date("2026-09-17T03:30:00.000Z"),
      received_by: null,
      shipper: null,
    },
    business: {
      corporate_reason: "Transportes Silva Ltda",
      fantasy_name: null,
      cnpj: "11222333000166",
    },
    driver: null,
    route: null,
    proof: null,
    occurrences: [],
  });
  documents.documents.push({
    id: "doc-1",
    deliveryId: "018f0000-0000-7000-8000-0000000000e1",
    businessId: BUSINESS,
    storage_key: `deliveryProofs/${BUSINESS}/doc-1.pdf`,
    sha256: createHash("sha256").update(BYTES).digest("hex"),
    verification_token: TOKEN,
    size_bytes: BYTES.length,
    version: 1,
    generated_at: new Date(),
    ...DELIVERY_PROOF_DOCUMENT_COLUMN_DEFAULTS,
  });

  const uploads = {
    readObject,
    getFileUrl: async () => "https://signed.example/doc-1.pdf",
  } as unknown as UploadService;

  return new VerifyProofDocumentUseCase(documents, uploads).execute({
    token: TOKEN,
  });
}

describe("GET /public/verify-proof with storage that does not answer", () => {
  it("refuses with the retryable 503, never `intact: false`", async () => {
    const outage = new AppError(
      "O armazenamento de arquivos está indisponível no momento. Tente novamente em instantes.",
      503,
      "STORAGE_UNAVAILABLE",
    );

    const settled = await verifyWith(async () => {
      throw outage;
    }).then(
      (value) => ({ value, error: null }),
      (error: unknown) => ({ value: null, error }),
    );

    expect(settled.value).toBeNull();
    expect((settled.error as AppError).statusCode).toBe(503);
    expect((settled.error as AppError).code).toBe("STORAGE_UNAVAILABLE");
  });

  it("still answers `intact: false` with no hash for a file that is gone", async () => {
    const result = await verifyWith(async () => null);

    expect(result.intact).toBe(false);
    expect(result.storedSha256).toBeNull();
  });
});

let document: Json;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = app.swagger() as Json;
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

function response(route: string, method: string, status: string): Json {
  const found = document.paths?.[route]?.[method]?.responses?.[status];

  if (!found) throw new Error(`${method} ${route} não documenta ${status}`);

  return found;
}

function body(route: string, method: string, status: string): Json {
  return response(route, method, status).content?.["application/json"]
    ?.schema as Json;
}

/** What every line after the meta line of an NDJSON listing is said to carry. */
function ndjsonItem(route: string, method: string): Json {
  return response(route, method, "200").content?.["application/x-ndjson"]
    ?.schema?.oneOf?.[1] as Json;
}

describe("the published document, for a client of the other version", () => {
  it("documents the storage 503 on the public proof check, with retry-after", () => {
    const unavailable = response("/public/verify-proof/{token}", "get", "503");
    const codes = String(
      unavailable.content?.["application/json"]?.schema?.properties?.code
        ?.description ?? "",
    );

    expect(codes).toContain("STORAGE_UNAVAILABLE");
    expect(codes).toContain("SERVICE_UNAVAILABLE");
    expect(unavailable.headers?.["retry-after"]).toBeDefined();
  });

  it("names STORAGE_UNAVAILABLE among the proof document's 503s", () => {
    expect(
      response(
        "/delivery/proof-document/{deliveryId}/business/{businessId}",
        "get",
        "503",
      ).description,
    ).toContain("STORAGE_UNAVAILABLE");
  });

  it("requires the fleet breakdown on entitlements (never cached)", () => {
    const data = body("/business/entitlements/{businessId}", "get", "200")
      .properties.data;

    expect(data.required).toContain("vehicle_status_counts");
    expect(data.properties.vehicle_status_counts.required).toEqual([
      "ACTIVE",
      "BLOCKED",
      "IN_ROUTE",
      "INACTIVE",
    ]);
    // What the previous web reads keeps its name and meaning.
    expect(data.required).toEqual(
      expect.arrayContaining(["vehicle_count", "vehicle_limit"]),
    );
  });

  it("keeps `unrecorded` optional: the MASTER overview copy in Redis may predate it", () => {
    const stats = body("/dashboard/overview", "get", "200").properties
      .maintenanceStats;

    expect(stats.properties).toHaveProperty("unrecorded");
    expect(stats.required).toEqual(["pending", "recent", "overdue"]);
  });

  /**
   * Plan of 02/11/2026 (D2): the e-mail is loosened in this release and
   * written NULL only in the next one. This release must already serve a
   * row without one — a required field would make the serializer answer
   * 500 to the driver's /user/me after a rollback from the next release.
   */
  it("serves a user without an e-mail on /user/me, with the settings optional (D2, M1)", () => {
    const nullable = (schema: Json) =>
      schema?.nullable === true ||
      (Array.isArray(schema?.type) && schema.type.includes("null")) ||
      Boolean(schema?.anyOf?.some((option: Json) => option.type === "null"));

    const me = body("/user/me", "get", "200").properties.user;

    expect(nullable(me.properties.email)).toBe(true);
    // M1: the settings are new, and the app reads them as optional too.
    expect(me.properties).toHaveProperty("businessSettings");
    expect(me.required ?? []).not.toContain("businessSettings");
  });

  it("serves a WhatsApp template without a body on the template list (B3)", () => {
    const nullable = (schema: Json) =>
      schema?.nullable === true ||
      (Array.isArray(schema?.type) && schema.type.includes("null")) ||
      Boolean(schema?.anyOf?.some((option: Json) => option.type === "null"));

    const operations = Object.entries(document.paths ?? {})
      .filter(([path]) => path.includes("message-template"))
      .flatMap(([, methods]) => Object.values(methods as Json) as Json[]);
    const item = operations.flatMap((operation) =>
      operation?.responses?.["200"]?.content?.["application/json"]?.schema
        ?.properties?.data?.items
        ? [
            operation.responses["200"].content["application/json"].schema
              .properties.data.items,
          ]
        : [],
    )[0];

    expect(item, "a message-template list with items").toBeDefined();
    expect(nullable(item.properties.body)).toBe(true);
  });

  it("documents a vehicle's history line as the driver's view, promising no money", () => {
    const item = ndjsonItem(
      "/service-order/search-service-order-by-vehicle/{vehicleId}",
      "get",
    );

    expect(item?.properties).toHaveProperty("parts");

    for (const key of [
      "total_amount",
      "parts_total",
      "supplier",
      "supplierId",
    ]) {
      expect(item.properties, key).not.toHaveProperty(key);
    }

    const part = item.properties.parts.items.properties;

    expect(part).toHaveProperty("quantity");
    expect(part).not.toHaveProperty("unit_price");
    expect(part).not.toHaveProperty("discount_percentage");
  });

  it("keeps the probe fields optional: the shared provider report may predate them", () => {
    const item = body("/health/providers", "get", "200").properties.providers
      .items;

    for (const field of ["attempts", "transient", "failure_kind"]) {
      expect(item.properties, field).toHaveProperty(field);
      expect(item.required, field).not.toContain(field);
    }
  });
});

const WEB = resolve(process.cwd(), "..", "trajetto-ui", "src");

function webSource(...path: string[]): string {
  return readFileSync(join(WEB, ...path), "utf8");
}

describe.skipIf(!existsSync(WEB))(
  "the web, against the other API version (sibling checkout)",
  () => {
    it("reads the fleet breakdown as optional", () => {
      expect(
        webSource("actions", "business", "entitlements", "index.ts"),
      ).toMatch(/vehicle_status_counts\?:/);
    });

    it("reads `unrecorded` as optional", () => {
      expect(
        webSource(
          "app",
          "(protected)",
          "_components",
          "overview-dashboard",
          "shared",
          "common.types.ts",
        ),
      ).toMatch(/unrecorded\?:/);
    });

    it("reads the probe fields as optional", () => {
      const providers = webSource(
        "actions",
        "health",
        "get-health-providers",
        "index.ts",
      );

      expect(providers).toMatch(/attempts\?:/);
      expect(providers).toMatch(/transient\?:/);
      expect(providers).toMatch(/failure_kind\?:/);
    });

    it("shows a vehicle's service orders to the driver without the money this API stopped sending", () => {
      const card = webSource(
        "app",
        "(protected)",
        "_components",
        "driver",
        "service-orders",
        "index.tsx",
      );

      expect(card).not.toMatch(
        /total_amount|supplier|unit_price|formatToBrazilianCurrency/,
      );
    });
  },
);
