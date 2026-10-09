import { z, type ZodTypeAny } from "zod";

/**
 * Responses whose runtime schema cannot be the shape the document shows.
 *
 * Two kinds, both rendered by the OpenAPI transform:
 *
 *   * FILES. The exports write straight to the raw socket and the template is
 *     a Buffer, so no serializer ever sees the body. They used to publish no
 *     2xx at all — a client could not tell from /docs that the call ever
 *     succeeds, what content type comes back, or the name to save it under.
 *
 *   * PASS-THROUGH payloads (`documentedAs`). The driver's day, the delivery
 *     detail and the chat are served through `z.unknown()` on purpose: a
 *     strict response schema would silently STRIP any field the app reads and
 *     the schema forgot, and the app builds in the stores are older than this
 *     code. The runtime keeps passing the body through; the document shows
 *     the typed shape, which the contract tests hold to the DTOs.
 */
interface FileDoc {
  contentTypes: string[];
  filename: string;
  description: string;
}

const FILE_DOCS = new WeakMap<object, FileDoc>();
const DOCUMENTED_AS = new WeakMap<object, ZodTypeAny>();

const CSV = "text/csv";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** A download. The returned schema is a marker the serializer never runs. */
function fileResponse(doc: FileDoc): ZodTypeAny {
  const runtime = z.any();

  FILE_DOCS.set(runtime, doc);

  return runtime;
}

/** The reports behind `?format=csv|excel`, all written by export-pipeline. */
function exportFileResponse(filename: string): ZodTypeAny {
  return fileResponse({
    contentTypes: [CSV, XLSX],
    filename: `${filename}.csv | ${filename}.xlsx`,
    description:
      "O arquivo, em stream: `text/csv` (separado por `;`, UTF-8) com `format=csv`, a planilha `.xlsx` com `format=excel`. NÃO é JSON. O nome vem em `Content-Disposition`, exposto ao navegador (Access-Control-Expose-Headers). Um erro de validação ou de permissão chega antes do primeiro byte, como JSON, com o status do erro.",
  });
}

/**
 * The same runtime schema, shown in the document as `documented`.
 *
 * `.describe()` clones the runtime schema without changing what it accepts,
 * so a schema shared by two routes is never marked for both.
 */
function documentedAs<T extends ZodTypeAny>(runtime: T, documented: ZodTypeAny): T {
  const marked = runtime.describe(runtime.description ?? "") as T;

  DOCUMENTED_AS.set(marked, documented);

  return marked;
}

function fileDocFor(schema: unknown): FileDoc | undefined {
  return schema && typeof schema === "object" ? FILE_DOCS.get(schema) : undefined;
}

function documentedDocFor(schema: unknown): ZodTypeAny | undefined {
  return schema && typeof schema === "object"
    ? DOCUMENTED_AS.get(schema)
    : undefined;
}

export {
  CSV,
  XLSX,
  documentedAs,
  documentedDocFor,
  exportFileResponse,
  fileDocFor,
  fileResponse,
  type FileDoc,
};
