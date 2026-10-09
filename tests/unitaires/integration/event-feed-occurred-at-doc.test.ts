import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

/**
 * The event feed's `occurred_at`, as the public reference explains it
 * (MOB-08).
 *
 * It used to be the instant the event was written. Since the driver's app
 * stamps what it did offline, it is the instant of the FACT — a proof signed
 * at 10:05 in a dead zone and received at 13:40 is published at 13:40 with
 * `occurred_at` 10:05, earlier than events a poller already read. The
 * `updated_since` filter stays on the receipt. An integrator who drops
 * events older than the newest `occurred_at` it has seen loses exactly the
 * offline proofs; the reference is the only place that can warn them.
 *
 * No database: nothing here sends a request with a key.
 */
type JsonSchema = {
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
};

let document: {
  paths: Record<
    string,
    Record<
      string,
      {
        responses: Record<
          string,
          { content?: Record<string, { schema?: JsonSchema }> }
        >;
      }
    >
  >;
};
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

/** Every schema named `name`, anywhere under `schema`. */
function propertiesNamed(schema: JsonSchema | undefined, name: string): JsonSchema[] {
  if (!schema) return [];

  const own = schema.properties?.[name] ? [schema.properties[name]] : [];

  return [
    ...own,
    ...Object.values(schema.properties ?? {}).flatMap((child) =>
      propertiesNamed(child, name),
    ),
    ...propertiesNamed(schema.items, name),
    ...(schema.anyOf ?? []).flatMap((child) => propertiesNamed(child, name)),
  ];
}

describe("the event feed's occurred_at, as published", () => {
  it("says it is the time of the fact and that updated_since filters on arrival", () => {
    const ok = document.paths["/integration/v1/events"]?.get?.responses["200"];
    const schema = ok?.content?.["application/json"]?.schema;

    const [field] = propertiesNamed(schema, "occurred_at");

    expect(field, "occurred_at is not in the published event shape").toBeDefined();

    const description = field.description ?? "";

    expect(description).toMatch(/updated_since/);
    expect(description).toMatch(/anterior/i);
  });
});
