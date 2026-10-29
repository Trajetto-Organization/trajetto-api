import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * Published-contract fixes from the final integration, read back from the
 * running application's document (the same one /docs serves).
 */
interface Schema {
  type?: string;
  description?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
}

interface Operation {
  summary?: string;
  description?: string;
  responses: Record<string, { content?: Record<string, { schema?: Schema }> }>;
  [extension: string]: unknown;
}

let document: { paths: Record<string, Record<string, Operation>> };
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = app.swagger() as unknown as typeof document;
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

function operation(path: string, method = "get"): Operation {
  const found = document.paths[path]?.[method];

  if (!found) throw new Error(`Rota não documentada: ${method} ${path}`);

  return found;
}

function jsonSchema(op: Operation, status: string): Schema {
  const schema = op.responses[status]?.content?.["application/json"]?.schema;

  if (!schema) throw new Error(`sem schema JSON para ${status}`);

  return schema;
}

describe("the final integration's published fixes", () => {
  /**
   * Decision 4.7: the vehicle picker lets a dispatcher in with
   * delivery_manage:write. The document named only vehicle_manage:read as a
   * requirement, so a generated client (or the /docs portal) said a
   * dispatcher could not call it.
   */
  it("documents the vehicle picker's two keys as alternatives", () => {
    const picker = operation("/vehicle/search-vehicle-business");

    expect(picker["x-permissions-any"]).toEqual([
      [
        { key: "vehicle_manage", access: "read" },
        { key: "delivery_manage", access: "write" },
      ],
    ]);
    expect(picker["x-permissions"]).toBeUndefined();
  });

  /**
   * Decision 11.3: the proof document's refusals carry `code`
   * (DELIVERY_NOT_FOUND, DELIVERY_NOT_SETTLED, PERMISSION_DENIED…), and the
   * published schema said `{ message }` only.
   */
  it("publishes the proof document's refusals with their code", () => {
    const proof = operation(
      "/delivery/proof-document/{deliveryId}/business/{businessId}",
    );

    for (const status of ["400", "403", "404", "409"]) {
      expect(
        Object.keys(jsonSchema(proof, status).properties ?? {}),
        status,
      ).toContain("code");
    }
  });

  it("describes the public proof check in Portuguese (decision 11.4)", () => {
    expect(operation("/public/verify-proof/{token}").summary).toBe(
      "Confere um comprovante de entrega pelo código impresso",
    );
  });

  /**
   * The operation summary's counters changed meaning (decision 7.1:
   * "Designadas" is the tower's day load) with nothing in the document to
   * say which.
   */
  it("describes every counter of the operation summary", () => {
    const data = jsonSchema(operation("/delivery/operation-summary"), "200")
      .properties!.data;

    const totals = data.properties!.totals.properties!;
    const driver = data.properties!.drivers.items!.properties!;

    for (const key of [
      "unassigned",
      "designated",
      "inRoute",
      "deliveredToday",
      "failedToday",
      "occurrencesToday",
    ]) {
      expect(totals[key]?.description, `totals.${key}`).toBeTruthy();
    }

    for (const key of [
      "designated",
      "inRoute",
      "deliveredToday",
      "failedToday",
    ]) {
      expect(driver[key]?.description, `drivers[].${key}`).toBeTruthy();
    }
  });
});
