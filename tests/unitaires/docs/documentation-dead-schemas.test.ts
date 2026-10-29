import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every schema a *-documentation.ts file publishes in its schemas/responses
 * objects is read by some route. A dead entry is worse than noise: the next
 * person documents a route from it and publishes a body (often a code-less
 * `{ message }`) that the handler never sends.
 */
const SRC = path.join(process.cwd(), "src");
const DOCS = path.join(SRC, "routes", "documentation");

function sources(dir: string, out: Array<[string, string]> = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) sources(full, out);
    else if (full.endsWith(".ts")) out.push([full, readFileSync(full, "utf8")]);
  }

  return out;
}

/** Top-level keys of each `const name = {` … `};` object in a file. */
function documentedEntries(source: string) {
  const entries: Array<{
    object: string;
    key: string;
    start: number;
    end: number;
  }> = [];
  const objects = /^(?:export )?const (\w+)\s*(?::[^=]+)?=\s*\{\s*$/gm;

  for (const match of source.matchAll(objects)) {
    const object = match[1];
    const start = match.index! + match[0].length;
    const end = source.indexOf("\n};", start);

    // A field bag spread into z.object({ ...fields }) is a shape, not a schema.
    if (end < 0 || new RegExp(`\\.\\.\\.${object}\\b`).test(source)) continue;

    const body = source.slice(start, end);
    const keys = new Set(
      [...body.matchAll(/^ {2}(\w+)\s*(?:[:,(]|\r?$)/gm)].map(([, key]) => key),
    );

    for (const key of keys)
      entries.push({ object, key, start: match.index!, end });
  }

  return entries;
}

function deadEntries(files: Array<[string, string]>, docFiles: string[]) {
  const dead: string[] = [];

  for (const docFile of docFiles) {
    const own = files.find(([file]) => file === docFile)![1];

    for (const { object, key, start, end } of documentedEntries(own)) {
      const read = new RegExp(`\\.${key}\\b`);
      const used = files.some(([file, text]) =>
        file === docFile
          ? read.test(text.slice(0, start) + text.slice(end))
          : read.test(text),
      );

      if (!used) dead.push(`${path.basename(docFile)} ${object}.${key}`);
    }
  }

  return dead;
}

describe("the documentation schemas", () => {
  it("publishes no schema that no route reads", () => {
    const files = sources(SRC);
    const docFiles = files
      .map(([file]) => file)
      .filter(
        (file) =>
          path.dirname(file) === DOCS && file.endsWith("-documentation.ts"),
      );

    expect(docFiles.length).toBeGreaterThan(20);
    expect(deadEntries(files, docFiles)).toEqual([]);
  });

  it("finds a dead entry, and only the dead one (self-test)", () => {
    const doc = path.join(DOCS, "probe-documentation.ts");
    const files: Array<[string, string]> = [
      [
        doc,
        [
          "const probeResponses = {",
          "  read: z.object({}),",
          "  forgotten: z.object({ message: z.string() }),",
          "};",
        ].join("\n"),
      ],
      [
        path.join(SRC, "routes", "probe-routes.ts"),
        "response: { 200: probeResponses.read }",
      ],
    ];

    expect(deadEntries(files, [doc])).toEqual([
      "probe-documentation.ts probeResponses.forgotten",
    ]);
  });
});
