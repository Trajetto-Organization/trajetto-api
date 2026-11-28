import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";
import { util } from "zod/v4/core";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";
import {
  introspectRoutes,
  type IntrospectedRoute,
} from "../contract/support/introspect-routes";
import {
  inputSchemasOf,
  walkInput,
  type InputNode,
} from "../contract/support/input-schemas";

/**
 * Every list a request may carry has a ceiling (`maxItems`), at every depth
 * of the body, the query and the path.
 *
 * A list with no `.max()` is parsed whole, element by element, whatever its
 * length: the body limit is the only bound, and each invalid element adds an
 * issue the error handler answers and logs. With zod 3 even a `.max()` did
 * not stop it (GHSA-mrhx-c7xc-m3w5, tests/unitaires/http/oversized-array).
 * zod 4 refuses a list past a LEADING size check before reading any element,
 * so the `.max()` goes before any `.refine()`, `.superRefine()` or
 * `.transform()` of the same list (a `.min()` in front does not matter).
 *
 * The document shows the ceiling and not its place among the checks, so the
 * order is read from the schemas the routes validate with (and the ones a
 * controller parses by hand and documents), with zod's own rule
 * (`util.sizeCaps`, which stops at the first check that is not a size).
 * A record has no such stop in zod 4: it counts its entries in a preprocess
 * first (boundedRecord), or each refused entry is one more issue.
 */
type Json = Record<string, any>;

let routes: IntrospectedRoute[];
let document: Json;
let close: () => Promise<void>;

beforeAll(async () => {
  const introspected = await introspectRoutes();

  routes = introspected.routes;
  document = introspected.document as unknown as Json;
  close = introspected.close;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

const COMBINATORS = ["anyOf", "oneOf", "allOf"];

function isArray(schema: Json): boolean {
  return (
    schema.type === "array" ||
    (Array.isArray(schema.type) && schema.type.includes("array"))
  );
}

function resolveRef(schema: Json): Json {
  if (typeof schema.$ref !== "string") return schema;

  const name = schema.$ref.replace(/^#\/components\/schemas\//, "");

  return document.components?.schemas?.[name] ?? {};
}

/** The paths of every array without `maxItems` under `schema`. */
function unboundedArrays(
  schema: unknown,
  path: string,
  seen = new Set<Json>(),
): string[] {
  if (!schema || typeof schema !== "object") return [];

  const node = resolveRef(schema as Json);

  if (seen.has(node)) return [];
  seen.add(node);

  const found: string[] = [];

  if (isArray(node) && typeof node.maxItems !== "number") found.push(path);

  for (const [key, child] of Object.entries<Json>(node.properties ?? {})) {
    found.push(...unboundedArrays(child, `${path}.${key}`, seen));
  }

  found.push(...unboundedArrays(node.items, `${path}[]`, seen));

  if (
    node.additionalProperties &&
    typeof node.additionalProperties === "object"
  ) {
    found.push(
      ...unboundedArrays(node.additionalProperties, `${path}{}`, seen),
    );
  }

  for (const combinator of COMBINATORS) {
    for (const member of (node[combinator] ?? []) as Json[]) {
      found.push(...unboundedArrays(member, path, seen));
    }
  }

  return found;
}

const operations = () =>
  Object.entries<Json>(document.paths ?? {}).flatMap(([route, methods]) =>
    Object.entries<Json>(methods).map(([method, operation]) => ({
      id: `${method.toUpperCase()} ${route}`,
      operation,
    })),
  );

/** Every node of every schema a request is read with, each schema once. */
function inputNodes(): InputNode[] {
  const nodes: InputNode[] = [];
  const seen = new Set<ZodType>();

  for (const route of routes) {
    for (const { id, schema } of inputSchemasOf(route)) {
      walkInput(schema, id, (node) => nodes.push(node), seen);
    }
  }

  return nodes;
}

const kindOf = (schema: ZodType) => schema._zod.def.type;

/** zod's own early stop: a ceiling among the checks before any other. */
function stopsAtItsCeiling(list: ZodType): boolean {
  return util.sizeCaps(list._zod.def.checks).length > 0;
}

/** The schema that sees the record first: its preprocess, when it has one. */
function recordGuard({ schema, parent }: InputNode): ZodType {
  if (!parent || kindOf(parent) !== "pipe") return schema;

  const pipe = parent._zod.def as unknown as { in: ZodType; out: ZodType };

  return pipe.out === schema && kindOf(pipe.in) === "transform"
    ? parent
    : schema;
}

/** 1,000 entries with a key and a value no schema here accepts. */
const OVERSIZED_RECORD = Object.fromEntries(
  Array.from({ length: 1_000 }, (_, index) => [
    `${"k".repeat(1_000)}${index}`,
    {},
  ]),
);

describe("the lists a request carries", () => {
  it("are found in the document (the check reads real schemas)", () => {
    // import-xml's `files` is a list with its cap: if this stops finding
    // it, the walk below proves nothing.
    const importXml = operations().find(
      ({ id }) => id === "POST /delivery/import-xml/{businessId}",
    );
    const files =
      importXml?.operation.requestBody?.content?.["application/json"]?.schema
        ?.properties?.files;

    expect(files?.type).toBe("array");
    expect(files?.maxItems).toBe(25);
  });

  it("all have a maxItems, in the body, the query and the path", () => {
    const unbounded = operations().flatMap(({ id, operation }) => [
      ...Object.entries<Json>(operation.requestBody?.content ?? {}).flatMap(
        ([type, media]) => unboundedArrays(media.schema, `${id} body(${type})`),
      ),
      ...((operation.parameters ?? []) as Json[]).flatMap((parameter) =>
        unboundedArrays(
          parameter.schema,
          `${id} ${parameter.in}.${parameter.name}`,
        ),
      ),
    ]);

    expect(unbounded).toEqual([]);
  });

  it("are found among the schemas the routes read (the walk reaches them)", () => {
    const paths = inputNodes().map(({ path }) => path);

    expect(paths).toContain(
      "POST /delivery/import-xml/{businessId} body.files",
    );
    // A list a controller parses by hand, only documented on the route.
    expect(
      paths.some((path) =>
        /^POST \/integration\/v1\/deliveries body \(documented\)\.items$/.test(
          path,
        ),
      ),
    ).toBe(true);
  });

  it("tells a ceiling in front from a ceiling behind a refinement", () => {
    const item = z.object({ a: z.string() });

    expect(
      stopsAtItsCeiling(
        z
          .array(item)
          .max(25)
          .superRefine(() => {}),
      ),
    ).toBe(true);
    expect(stopsAtItsCeiling(z.array(item).min(1).max(25))).toBe(true);
    expect(
      stopsAtItsCeiling(
        z
          .array(item)
          .superRefine(() => {})
          .max(25),
      ),
    ).toBe(false);
    expect(
      stopsAtItsCeiling(
        z
          .array(item)
          .refine(() => true)
          .max(25),
      ),
    ).toBe(false);
    expect(stopsAtItsCeiling(z.array(item))).toBe(false);
  });

  it("all stop at their ceiling before reading an element", () => {
    const late = inputNodes()
      .filter(({ schema }) => kindOf(schema) === "array")
      .filter(({ schema }) => !stopsAtItsCeiling(schema))
      .map(({ path }) => path);

    expect(late).toEqual([]);
  });
});

describe("the records a request carries", () => {
  it("are found among the schemas the routes read", () => {
    const records = inputNodes()
      .filter(({ schema }) => kindOf(schema) === "record")
      .map(({ path }) => path);

    expect(records).toContain(
      "POST /delivery/report-occurrence/{deliveryId}/business/{businessId} body.form_answers",
    );
  });

  it("count their entries before reading them: one issue, not one per entry", () => {
    const flooded = inputNodes()
      .filter(({ schema }) => kindOf(schema) === "record")
      .map((node) => ({
        path: node.path,
        result: recordGuard(node).safeParse(OVERSIZED_RECORD),
      }))
      .filter(({ result }) => !result.success && result.error.issues.length > 1)
      .map(({ path }) => path);

    expect(flooded).toEqual([]);
  });
});
