import type { FastifyRequest } from "fastify";
import { ZodError } from "zod";

/**
 * Text PostgreSQL cannot store, refused at the door.
 *
 * Two kinds of character pass every zod rule in the product and then crash
 * the write (or the search) inside the query engine:
 *
 *   - U+0000: `text` columns cannot hold it (SQLSTATE 22021), and JSON can
 *     carry it as `\u0000`, a query string as `%00`;
 *   - a lone UTF-16 surrogate (`\ud800` with no pair): not valid Unicode, and
 *     the engine refuses to encode it.
 *
 * Each one turned a request into a 500 logged at error level — on creates,
 * renames, tickets and every list's `search` — so anyone with a session could
 * fill the error alerts with noise that looks like a broken release. Neither
 * is ever typed by a person; both only arrive on purpose or from a corrupted
 * client. One check for every route, before validation, answers 400.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function isUnstorable(text: string): boolean {
  return text.includes("\u0000") || LONE_SURROGATE.test(text);
}

/**
 * The path of the first unstorable string in a parsed value (keys included),
 * or null. Iterative, so a deeply nested body cannot overflow the stack, and
 * linear: each node keeps a link to its parent and the path is rebuilt only
 * for the culprit. Copying the path at every level made a 400 kB body nested
 * 200 000 deep cost O(depth²) and froze the event loop for minutes.
 * Buffers (raw uploads, signed webhook bodies) are bytes, not text: skipped.
 */
const MAX_PATH_DEPTH = 16;

interface Node {
  value: unknown;
  key: string | number | null;
  parent: Node | null;
}

/** Leaf to root, then reversed; only the first levels name the field. */
function pathOf(node: Node, extra?: string): Array<string | number> {
  const reversed: Array<string | number> = extra === undefined ? [] : [extra];

  for (let at: Node | null = node; at && at.key !== null; at = at.parent) {
    reversed.push(at.key);
  }

  return reversed.reverse().slice(0, MAX_PATH_DEPTH);
}

function findUnstorableText(root: unknown): Array<string | number> | null {
  const stack: Node[] = [{ value: root, key: null, parent: null }];

  while (stack.length > 0) {
    const node = stack.pop()!;
    const { value } = node;

    if (typeof value === "string") {
      if (isUnstorable(value)) return pathOf(node);
      continue;
    }

    if (!value || typeof value !== "object" || Buffer.isBuffer(value)) continue;

    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        stack.push({ value: value[index], key: index, parent: node });
      }
      continue;
    }

    for (const key of Object.keys(value)) {
      if (isUnstorable(key)) return pathOf(node, key);
      stack.push({ value: (value as Record<string, unknown>)[key], key, parent: node });
    }
  }

  return null;
}

const MESSAGE = "O texto enviado contém um caractere inválido.";

/**
 * Global `preValidation` hook: params, query and body, after parsing and
 * before any route reads them. Answers like any other field refusal (400
 * VALIDATION_ERROR with `issues`), so clients need nothing new.
 */
async function rejectUnstorableText(request: FastifyRequest): Promise<void> {
  for (const [source, value] of [
    ["params", request.params],
    ["query", request.query],
    ["body", request.body],
  ] as const) {
    const path = findUnstorableText(value);

    if (path) {
      throw new ZodError([{ code: "custom", path: [source, ...path], message: MESSAGE }]);
    }
  }
}

export { findUnstorableText, isUnstorable, rejectUnstorableText };
