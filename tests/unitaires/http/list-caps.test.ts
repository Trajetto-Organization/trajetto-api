import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";

import { EnumPermissionKey } from "@/config/permissions";
import { bulkConfigurePermissionsSchema } from "@/schemas/bulk-configure-permissions-schema";
import {
  createApiKeySchema,
  saveWebhookEndpointSchema,
} from "@/schemas/integration-schema";
import {
  MAX_REORDERED_CARDS,
  reorderKanbanCardsSchema,
} from "@/schemas/reorder-kanban-cards-schema";
import {
  MAX_REORDERED_COLUMNS,
  reorderKanbanColumnsSchema,
} from "@/schemas/reorder-kanban-columns-schema";
import { reportDeliveryOccurrenceSchema } from "@/schemas/report-delivery-occurrence-schema";
import { API_SCOPES } from "@/shared/integration/api-key-rules";
import {
  ALL_TOPICS,
  TOPIC_WILDCARDS,
} from "@/shared/integration/webhook-catalogue";
// The pt-BR defaults, installed as the HTTP entry installs them.
import "@/shared/validation/zod-pt-br";

/**
 * The ceilings the zod 4 migration gave the lists that had none, and the
 * two records a request may carry: one past the ceiling is ONE issue with
 * the field's own sentence, never one per element.
 *
 * Each element (or entry) here is one no schema accepts, so a ceiling read
 * after the elements, or behind a refinement, would show up as thousands of
 * issues (tests/unitaires/docs/request-array-bounds checks the order on
 * every route; this pins the numbers and the sentences).
 */
function issuesAt(schema: ZodType, body: unknown, field: string) {
  const result = schema.safeParse(body);

  return result.success
    ? []
    : result.error.issues
        .filter((issue) => issue.path[0] === field)
        .map((issue) => ({ path: issue.path, message: issue.message }));
}

const invalidElements = (count: number) => Array<null>(count).fill(null);

const invalidEntries = (count: number) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`chave${index}`, {}]),
  );

describe("a list one past its ceiling", () => {
  it.each([
    {
      name: "the Kanban columns of a reorder",
      schema: reorderKanbanColumnsSchema,
      field: "columns",
      ceiling: MAX_REORDERED_COLUMNS,
      message: "Reordene no máximo 500 colunas por vez.",
    },
    {
      name: "the Kanban cards of a reorder",
      schema: reorderKanbanCardsSchema,
      field: "cards",
      ceiling: MAX_REORDERED_CARDS,
      message: "Reordene no máximo 10.000 cards por vez.",
    },
    {
      name: "the rows of a bulk permission set (one per resource)",
      schema: bulkConfigurePermissionsSchema,
      field: "permissions",
      ceiling: Object.values(EnumPermissionKey).length,
      message: "Há permissões demais nesta lista.",
    },
    {
      name: "the scopes of an API key (each once)",
      schema: createApiKeySchema,
      field: "scopes",
      ceiling: API_SCOPES.length,
      message: `Escolha no máximo ${API_SCOPES.length} escopos, cada um uma vez.`,
    },
    {
      name: "the topics of a webhook (the whole catalogue)",
      schema: saveWebhookEndpointSchema,
      field: "topics",
      ceiling: ALL_TOPICS.length + TOPIC_WILDCARDS.length,
      message: `Escolha no máximo ${ALL_TOPICS.length + TOPIC_WILDCARDS.length} tópicos, cada um uma vez.`,
    },
  ])(
    "$name is one issue with its sentence",
    ({ schema, field, ceiling, message }) => {
      expect(
        issuesAt(schema, { [field]: invalidElements(ceiling + 1) }, field),
      ).toEqual([{ path: [field], message }]);
    },
  );
});

describe("a record one past its ceiling", () => {
  it.each([
    {
      name: "the answers of an occurrence form",
      schema: reportDeliveryOccurrenceSchema,
      field: "form_answers",
      ceiling: 50,
      message: "Respostas demais para um formulário de ocorrência.",
    },
    {
      name: "the headers of a webhook",
      schema: saveWebhookEndpointSchema,
      field: "headers",
      ceiling: 20,
      message: "No máximo 20 cabeçalhos.",
    },
  ])(
    "$name is one issue with its sentence",
    ({ schema, field, ceiling, message }) => {
      expect(
        issuesAt(schema, { [field]: invalidEntries(ceiling + 1) }, field),
      ).toEqual([{ path: [field], message }]);
    },
  );

  it("is still read entry by entry under the ceiling", () => {
    expect(
      issuesAt(
        reportDeliveryOccurrenceSchema,
        { form_answers: { [`${"k".repeat(41)}`]: "sim", peso: {} } },
        "form_answers",
      ),
    ).toEqual([
      {
        path: ["form_answers", "k".repeat(41)],
        message: `O campo "form_answers.${"k".repeat(41)}" deve ter no máximo 40 caractere(s).`,
      },
      {
        path: ["form_answers", "peso"],
        message: 'O campo "form_answers.peso" tem um valor não aceito.',
      },
    ]);
  });
});
