import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * What the published contract says a departure resend answers, against what
 * the code does (IDEMP-19).
 *
 * The description once promised 409 ROUTE_STATUS_CONFLICT for a resend of a
 * route already out, while the code answered 200 with the route; a client
 * built from the document treated a success as an error. What it must say
 * now, each point pinned by a unit test in route-idempotency.test.ts:
 *
 * - a resend (no vehicle, or the same one) of a departure that happened —
 *   still running, or already finished — answers 200 with the route;
 * - naming a DIFFERENT vehicle for a route that already left is 400
 *   INVALID_ROUTE_TRANSITION (409 only when it races the first attempt);
 * - a route with no open stop left refuses to depart with 400
 *   ROUTE_WITHOUT_STOPS.
 */
interface OpenApiOperation {
  description?: string;
  responses: Record<string, unknown>;
}

type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
};

let document: OpenApiDocument;
let close: () => Promise<void>;

beforeAll(async () => {
  const { app } = await import("@/http");

  await app.ready();

  document = app.swagger() as unknown as OpenApiDocument;
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

function departure(): string {
  const operation =
    document.paths["/route/start-route/{routeId}/business/{businessId}"]?.post;

  expect(operation, "rota de partida não documentada").toBeTruthy();

  return operation!.description ?? "";
}

/** The sentence of the description that mentions `needle`. */
function sentenceAbout(description: string, needle: RegExp): string {
  return (
    description
      .split(/(?<=[.;])\s+/)
      .find((sentence) => needle.test(sentence)) ?? ""
  );
}

describe("the departure's published resend contract", () => {
  it("answers a resend of a departure that happened with 200, even after it finished", () => {
    const description = departure();

    // pt-BR since decision 11.4 (the internal /docs speaks Portuguese).
    expect(description).toMatch(/reenvio[^.]*200/i);
    expect(description).toMatch(/terminar|COMPLETED/);
  });

  it("does not promise 409 for a resend naming another vehicle", () => {
    const sentence = sentenceAbout(departure(), /outro veículo/i);

    expect(sentence, "a descrição não fala do veículo diferente").not.toBe("");
    expect(sentence).toMatch(/400 INVALID_ROUTE_TRANSITION/);
  });

  it("documents the refusal of a route with nothing left on it", () => {
    expect(departure()).toMatch(/ROUTE_WITHOUT_STOPS/);
  });
});
