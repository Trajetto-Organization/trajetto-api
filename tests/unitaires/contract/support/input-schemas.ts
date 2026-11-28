import type { ZodType } from "zod";

import type { IntrospectedRoute } from "./introspect-routes";

/**
 * The zod schemas a request is read with, walked node by node.
 *
 * The document says what a request may carry, but not how zod reads it:
 * whether a list stops at its ceiling before reading an element, or what an
 * absent key becomes. Those are properties of the schemas themselves, so the
 * checks that need them walk the schemas the routes really use: the ones
 * Fastify validates with, and the ones a controller parses by hand and
 * documents (`config.openapi`).
 */
export interface InputSchema {
  /** "POST /kanban/card/update/{cardId} body". */
  id: string;
  schema: ZodType;
}

export interface InputNode {
  schema: ZodType;
  /** "body.items[].description", for the failure message. */
  path: string;
  /** The schema this one sits in, when it has one. */
  parent: ZodType | undefined;
}

function isZod(value: unknown): value is ZodType {
  return typeof value === "object" && value !== null && "_zod" in value;
}

export function inputSchemasOf(route: IntrospectedRoute): InputSchema[] {
  const openapi = (route.config.openapi ?? {}) as Record<string, unknown>;
  const sources: Record<string, unknown> = {
    body: route.schema?.body,
    querystring: route.schema?.querystring,
    params: route.schema?.params,
    headers: route.schema?.headers,
    "body (documented)": openapi.body,
    "headers (documented)": openapi.headers,
  };

  return Object.entries(sources)
    .filter((entry): entry is [string, ZodType] => isZod(entry[1]))
    .map(([where, schema]) => ({ id: `${route.id} ${where}`, schema }));
}

// The wrappers whose inner schema reads the same value.
const WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "nonoptional",
  "readonly",
  "catch",
  "promise",
]);

/**
 * Every schema under `root`, depth first. A schema reused in many places is
 * visited once per walk, at the first path that reaches it.
 */
export function walkInput(
  root: ZodType,
  rootPath: string,
  visit: (node: InputNode) => void,
  seen = new Set<ZodType>(),
): void {
  const walk = (
    schema: unknown,
    path: string,
    parent: ZodType | undefined,
  ): void => {
    if (!isZod(schema) || seen.has(schema)) return;
    seen.add(schema);
    visit({ schema, path, parent });

    // The definitions are read as data: each kind keeps its children under
    // its own names.
    const def = schema._zod.def as unknown as Record<string, any>;

    if (WRAPPERS.has(def.type)) {
      walk(def.innerType, path, schema);

      return;
    }

    switch (def.type) {
      case "object":
        for (const [key, child] of Object.entries<unknown>(
          (schema as unknown as { shape: Record<string, unknown> }).shape,
        )) {
          walk(child, `${path}.${key}`, schema);
        }
        walk(def.catchall, `${path}{}`, schema);
        break;
      case "array":
        walk(def.element, `${path}[]`, schema);
        break;
      case "set":
        walk(def.valueType, `${path}[]`, schema);
        break;
      case "record":
      case "map":
        walk(def.keyType, `${path}{key}`, schema);
        walk(def.valueType, `${path}{}`, schema);
        break;
      case "tuple":
        (def.items as unknown[]).forEach((item, index) =>
          walk(item, `${path}[${index}]`, schema),
        );
        walk(def.rest, `${path}[]`, schema);
        break;
      case "union":
        for (const option of def.options as unknown[]) {
          walk(option, path, schema);
        }
        break;
      case "intersection":
        walk(def.left, path, schema);
        walk(def.right, path, schema);
        break;
      case "pipe":
        walk(def.in, path, schema);
        walk(def.out, path, schema);
        break;
      case "lazy":
        walk(def.getter(), path, schema);
        break;
      default:
        break;
    }
  };

  walk(root, rootPath, undefined);
}
