import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z, type ZodType } from "zod";

import { updateKanbanCardSchema } from "@/schemas/update-kanban-card-schema";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";
import {
  introspectRoutes,
  type IntrospectedRoute,
} from "../contract/support/introspect-routes";
import { inputSchemasOf, walkInput } from "../contract/support/input-schemas";

/**
 * What a key the client left out becomes: what it became with zod 3.
 *
 * Two shapes read an absent key differently in zod 4, with no compile error
 * and no failing parse:
 *
 *   - `.optional()` (or `.partial()`) over a `.default()`. zod 3's optional
 *     answered first, with undefined; zod 4 applies the default. On an edit
 *     body that writes the default over the stored value on every save: the
 *     permission's `canWrite` (`.default(false).optional()`) would have
 *     revoked writing whenever an edit left it out.
 *   - a preprocess into an optional result, whose function turns undefined
 *     into a value. zod 3 wrote that value; zod 4 leaves the key out.
 *
 * Read with zod's own flags, `optin` and `optout`: what the object asks of a
 * property when its key is missing. Over every object of the schemas the
 * routes read a request with (and the ones a controller parses by hand and
 * documents).
 */
let routes: IntrospectedRoute[];
let close: () => Promise<void>;

beforeAll(async () => {
  const introspected = await introspectRoutes();

  routes = introspected.routes;
  close = introspected.close;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

interface Property {
  path: string;
  schema: ZodType;
}

/** Every property of every object a request is read with, each once. */
function inputProperties(): Property[] {
  const properties: Property[] = [];
  const seen = new Set<ZodType>();

  for (const route of routes) {
    for (const { id, schema } of inputSchemasOf(route)) {
      walkInput(
        schema,
        id,
        ({ schema: node, path }) => {
          if (node._zod.def.type !== "object") return;

          for (const [key, property] of Object.entries(
            (node as z.ZodObject).shape,
          )) {
            properties.push({ path: `${path}.${key}`, schema: property });
          }
        },
        seen,
      );
    }
  }

  return properties;
}

/** zod 3 left the key out; zod 4 writes the default. */
function defaultsAnAbsentKey(property: ZodType): boolean {
  return (
    property._zod.optin === "defaulted" && property._zod.optout === "optional"
  );
}

/** zod 3 wrote what the schema makes of undefined; zod 4 leaves the key out. */
function dropsWhatUndefinedBecomes(property: ZodType): boolean {
  if (property._zod.optin !== "optional") return false;
  if (property._zod.optout !== "optional") return false;

  try {
    const result = property.safeParse(undefined);

    return result.success && result.data !== undefined;
  } catch {
    return false;
  }
}

/**
 * Accepted on purpose, each with its reason. The Kanban card's `completed`:
 * an edit that leaves it out keeps the card as it is, where zod 3 unchecked
 * it; the web sends the field on every save (docs/deploy.md, zod 4).
 */
const ACCEPTED_DROPS: ZodType[] = [updateKanbanCardSchema.shape.completed];

describe("an absent key in a request", () => {
  it("is told apart by the two checks (they read zod's real flags)", () => {
    const shape = z.object({
      overDefault: z.boolean().default(false).optional(),
      partialOverDefault: z.object({ a: z.number().default(1) }).partial().shape
        .a,
      defaultOverOptional: z.boolean().optional().default(true),
      preprocessed: z.preprocess(
        (value) => value ?? false,
        z.boolean().optional(),
      ),
      blankToNull: z.preprocess(
        (value) => (value === "" ? null : value),
        z.string().nullable().optional(),
      ),
    }).shape;

    expect(defaultsAnAbsentKey(shape.overDefault)).toBe(true);
    expect(defaultsAnAbsentKey(shape.partialOverDefault)).toBe(true);
    expect(defaultsAnAbsentKey(shape.defaultOverOptional)).toBe(false);
    expect(dropsWhatUndefinedBecomes(shape.preprocessed)).toBe(true);
    expect(dropsWhatUndefinedBecomes(shape.blankToNull)).toBe(false);
  });

  it("never gets a default where zod 3 left it out (.optional() over .default())", () => {
    const defaulted = inputProperties()
      .filter(({ schema }) => defaultsAnAbsentKey(schema))
      .map(({ path }) => path);

    expect(defaulted).toEqual([]);
  });

  it("never loses the value zod 3 wrote for it (a preprocess into an optional)", () => {
    const dropped = inputProperties().filter(({ schema }) =>
      dropsWhatUndefinedBecomes(schema),
    );

    // The accepted ones are still there: an entry that matches nothing
    // would hide a new case behind a stale reason.
    for (const accepted of ACCEPTED_DROPS) {
      expect(dropped.map(({ schema }) => schema)).toContain(accepted);
    }

    expect(
      dropped
        .filter(({ schema }) => !ACCEPTED_DROPS.includes(schema))
        .map(({ path }) => path),
    ).toEqual([]);
  });
});
