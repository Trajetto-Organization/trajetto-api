import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { DeliveryStatus, RouteStatus } from "@prisma/client";

/**
 * The public API as its reference publishes it, read out of the running
 * application.
 *
 * This is the contract an integrator codes against without ever talking to
 * us, so every sentence in it is a promise: a filter it lists has to filter,
 * a status it lists has to be one the API can answer, and the values of an
 * enum have to be the ones the API accepts.
 *
 * No database: nothing here sends a request with a key.
 */
interface Parameter {
  name: string;
  in: string;
  schema?: { enum?: string[] };
}

interface Operation {
  description?: string;
  parameters?: Parameter[];
  responses: Record<string, unknown>;
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

const operation = (path: string): Operation => {
  const found = document.paths[`/integration/v1${path}`]?.get;

  if (!found) throw new Error(`Rota não documentada: ${path}`);

  return found;
};

const queryParameter = (path: string, name: string) =>
  operation(path).parameters?.find(
    (parameter) => parameter.in === "query" && parameter.name === name,
  );

describe("the list filters, as published", () => {
  it("lists the delivery statuses on /deliveries", () => {
    expect(queryParameter("/deliveries", "status")?.schema?.enum).toEqual(
      Object.values(DeliveryStatus),
    );
  });

  it("lists the route statuses on /routes", () => {
    expect(queryParameter("/routes", "status")?.schema?.enum).toEqual(
      Object.values(RouteStatus),
    );
  });

  it("does not offer a status filter the event feed never applied", () => {
    expect(queryParameter("/events", "status")).toBeUndefined();
  });

  it("does not describe our internals to a customer", () => {
    // How the feed is stored is ours to change; what it guarantees is theirs.
    expect(operation("/events").description ?? "").not.toMatch(/outbox/i);
  });

  it("documents the 400 every keyed route answers to a bad parameter", () => {
    for (const path of [
      "/deliveries",
      "/deliveries/{id}",
      "/routes",
      "/routes/{id}",
      "/events",
    ]) {
      expect(Object.keys(operation(path).responses), path).toContain("400");
    }
  });
});
