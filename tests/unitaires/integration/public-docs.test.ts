import { describe, expect, it } from "vitest";

import {
  buildPublicApiDocument,
  renderPublicDocsPage,
} from "@/shared/integration/public-docs";

import {
  basicAuthMatches,
  docsAccessFor,
} from "@/shared/integration/docs-access";

/**
 * Two documents, and the difference between them is the whole point.
 *
 * `/docs` describes every endpoint of the product — including the ones only a
 * master can call. `/integration/docs` describes what a customer's API key can
 * reach, and is built by SUBTRACTION from the first: a reference maintained by
 * hand drifts, and the drift is silent because the reader believes it.
 */
const SOURCE = {
  openapi: "3.1.0",
  info: { title: "Trajetto API", version: "1.0.0" },
  paths: {
    "/integration/v1/deliveries": {
      get: {
        tags: ["integration"],
        responses: {
          200: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PublicDelivery" },
              },
            },
          },
        },
      },
    },
    "/integration/v1/routes/{id}": { get: { tags: ["integration"] } },
    "/integrations/api-keys": { get: { tags: ["integration-admin"] } },
    "/delivery/list-delivery": { get: { tags: ["delivery"] } },
    "/user/create-user": {
      post: {
        tags: ["user"],
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/InternalUser" },
            },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      apiKey: { type: "http", scheme: "bearer" },
    },
    schemas: {
      // Reached through the public path, and through it the item it nests.
      PublicDelivery: {
        type: "object",
        properties: { item: { $ref: "#/components/schemas/PublicItem" } },
      },
      PublicItem: { type: "object" },
      // Only an internal route refers to it; the other, nothing at all.
      InternalUser: { type: "object" },
      InternalSecret: { type: "object" },
    },
  },
};

describe("the public reference", () => {
  const document = buildPublicApiDocument(SOURCE);

  it("publishes only what an API key can reach", () => {
    expect(Object.keys(document.paths ?? {})).toEqual([
      "/integration/v1/deliveries",
      "/integration/v1/routes/{id}",
    ]);
  });

  it("does not publish the admin screens that manage the integration", () => {
    // `/integrations/...` shares a prefix by eye but not by rule. It is
    // session-authenticated: the credentials of an integration are not
    // managed through that integration, or a leaked key mints more keys.
    const paths = Object.keys(document.paths ?? {});

    expect(paths.some((path) => path.startsWith("/integrations/"))).toBe(false);
  });

  it("offers the key and never the session cookie", () => {
    const schemes = (document.components as { securitySchemes: object })
      .securitySchemes;

    // A public reference that offered "bearerAuth (JWT)" would invite an
    // integrator to try logging in as a person — the one thing this surface
    // does not do.
    expect(Object.keys(schemes)).toEqual(["apiKey"]);
  });

  it("keeps the shapes the remaining paths refer to, transitively", () => {
    // Pruning components by guessing which are still referenced ships a
    // dangling $ref, which renders as an empty box and tells the reader
    // nothing about what to send. Reachability through $ref cannot guess.
    const schemas = (
      document.components as { schemas: Record<string, unknown> }
    ).schemas;

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining(["PublicDelivery", "PublicItem"]),
    );
  });

  it("leaks no internal shape into the public reference (DOCS-13)", () => {
    // Copying every component published whatever the internal document
    // registered — an internal route's body, or a schema nobody refers to.
    // What remains is what the public paths reach, plus the webhook payloads.
    const schemas = (
      document.components as { schemas: Record<string, unknown> }
    ).schemas;

    expect(schemas.InternalUser).toBeUndefined();
    expect(schemas.InternalSecret).toBeUndefined();
    expect(
      Object.keys(schemas).filter(
        (name) =>
          !["PublicDelivery", "PublicItem"].includes(name) &&
          !name.startsWith("Webhook"),
      ),
    ).toEqual([]);
  });

  it("titles itself as the integration API, not as the product", () => {
    expect(document.info?.title).toContain("Integração");

    // The signature recipe is the single thing integrators get wrong, so it
    // is in the description rather than only in an endpoint's prose.
    expect(String(document.info?.description)).toContain("HMAC SHA-256");
    expect(String(document.info?.description)).toContain(
      "X-Trajetto-Signature",
    );
  });

  it("survives a source document with nothing in it", () => {
    const empty = buildPublicApiDocument({});

    expect(empty.paths).toEqual({});
    expect(
      (empty.components as { securitySchemes: object }).securitySchemes,
    ).toEqual({});
  });
});

describe("the portal page", () => {
  const html = renderPublicDocsPage("/integration/docs/openapi.json");

  it("points the renderer at the filtered document", () => {
    expect(html).toContain('data-url="/integration/docs/openapi.json"');
  });

  it("says where the raw document is when the renderer cannot load", () => {
    // A blank page has integrators emailing support about an outage that is
    // only their corporate proxy blocking a CDN.
    expect(html).toContain("<noscript");
    expect(html.match(/openapi\.json/g)?.length).toBeGreaterThan(2);
  });
});

describe("who may read the internal reference", () => {
  it("is open outside production", () => {
    expect(docsAccessFor("development", {}).kind).toBe("open");
    expect(docsAccessFor("test", {}).kind).toBe("open");
  });

  it("is closed in production until somebody configures it", () => {
    expect(docsAccessFor("production", {}).kind).toBe("disabled");
  });

  it("refuses a half configuration", () => {
    // A username with no password is somebody who half-configured this, and
    // opening the map on a half-configuration is the accident being prevented.
    expect(docsAccessFor("production", { user: "equipe" }).kind).toBe(
      "disabled",
    );

    expect(docsAccessFor("production", { password: "segredo" }).kind).toBe(
      "disabled",
    );
  });

  it("takes both halves together", () => {
    // Long enough to be accepted — a short one keeps it closed, see
    // docs-access-hardening.test.ts.
    const access = docsAccessFor("production", {
      user: "equipe",
      password: "segredo-longo-o-bastante",
    });

    expect(access.kind).toBe("basic");
  });
});

describe("checking the credential", () => {
  const expected = { user: "equipe", password: "segredo" };

  it("accepts the pair that was configured", () => {
    const header = `Basic ${Buffer.from("equipe:segredo").toString("base64")}`;

    expect(basicAuthMatches(header, expected)).toBe(true);
  });

  it("refuses a wrong password, a wrong user and a missing header", () => {
    const wrongPassword = `Basic ${Buffer.from("equipe:outro").toString(
      "base64",
    )}`;

    const wrongUser = `Basic ${Buffer.from("outro:segredo").toString(
      "base64",
    )}`;

    expect(basicAuthMatches(wrongPassword, expected)).toBe(false);
    expect(basicAuthMatches(wrongUser, expected)).toBe(false);

    expect(basicAuthMatches(undefined, expected)).toBe(false);
    expect(basicAuthMatches("Bearer algo", expected)).toBe(false);
  });

  it("refuses a password that merely starts the same", () => {
    // The check has to compare the whole value. A prefix match would let
    // somebody walk the secret one character at a time.
    const prefix = `Basic ${Buffer.from("equipe:seg").toString("base64")}`;

    expect(basicAuthMatches(prefix, expected)).toBe(false);
  });

  it("keeps a password containing a colon intact", () => {
    // The separator is the FIRST colon. Splitting on every one would silently
    // truncate any password with a colon in it, and the person who chose it
    // would be locked out with no message that explains why.
    const header = `Basic ${Buffer.from("equipe:a:b:c").toString("base64")}`;

    expect(
      basicAuthMatches(header, { user: "equipe", password: "a:b:c" }),
    ).toBe(true);
  });

  it("refuses a header with no colon at all", () => {
    const header = `Basic ${Buffer.from("equipe").toString("base64")}`;

    expect(basicAuthMatches(header, expected)).toBe(false);
  });
});
