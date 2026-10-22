import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  MAX_FORM_FIELDS,
  formatOccurrenceAnswer,
  normalizeFormFields,
  occurrenceFormFieldsSchema,
  readFormFields,
  sameFormFields,
  validateOccurrenceAnswers,
  type OccurrenceFormField,
} from "@/modules/occurrence-type/form/occurrence-form-rules";

/**
 * The occurrence form rules (decision 6.2), over the cases the web and the
 * app copies run too (fixtures/occurrence-form-cases.json).
 */
const cases = JSON.parse(
  readFileSync(
    join(__dirname, "fixtures", "occurrence-form-cases.json"),
    "utf8",
  ),
) as {
  form: unknown[];
  answers: Array<{
    name: string;
    given: Record<string, unknown>;
    kept: Record<string, unknown> | null;
    errors: string[];
  }>;
  definitions: Array<{ name: string; fields: unknown[]; valid: boolean }>;
};

const form = normalizeFormFields(occurrenceFormFieldsSchema.parse(cases.form))!;

describe("the shared answer cases", () => {
  it.each(cases.answers.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      const verdict = validateOccurrenceAnswers(form, entry.given);

      expect(Object.keys(verdict.errors).sort()).toEqual(
        [...entry.errors].sort(),
      );

      if (entry.errors.length === 0) {
        expect(verdict.answers).toEqual(entry.kept);
      }
    },
  );
});

describe("the shared definition cases", () => {
  it.each(cases.definitions.map((entry) => [entry.name, entry] as const))(
    "%s",
    (_name, entry) => {
      expect(occurrenceFormFieldsSchema.safeParse(entry.fields).success).toBe(
        entry.valid,
      );
    },
  );
});

describe("the definition", () => {
  it("refuses more than the field limit", () => {
    const fields = Array.from({ length: MAX_FORM_FIELDS + 1 }, (_, index) => ({
      key: `campo_${index}`,
      label: `Campo ${index}`,
      type: "text",
    }));

    const parsed = occurrenceFormFieldsSchema.safeParse(fields);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0].message).toBe(
      "O formulário aceita no máximo 20 campos.",
    );
  });

  it("says in Portuguese which field is wrong", () => {
    const parsed = occurrenceFormFieldsSchema.safeParse([
      { key: "motivo", label: "Motivo", type: "select", options: ["Único"] },
    ]);

    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((issue) => issue.message)).toContain(
      "A lista precisa de pelo menos 2 opções.",
    );
  });

  it("normalizes to one stored shape: defaults on, other types' props off", () => {
    const normalized = normalizeFormFields(
      occurrenceFormFieldsSchema.parse([
        { key: "a", label: "A", type: "text" },
        { key: "b", label: "B", type: "number", required: true },
        { key: "c", label: "C", type: "select", options: ["X", "Y"], help: "" },
      ]),
    );

    expect(normalized).toEqual([
      {
        key: "a",
        label: "A",
        type: "text",
        required: false,
        max_length: 200,
        multiline: false,
      },
      { key: "b", label: "B", type: "number", required: true, integer: false },
      {
        key: "c",
        label: "C",
        type: "select",
        required: false,
        options: ["X", "Y"],
      },
    ]);
  });

  it("treats no form and an empty form as the same stored null", () => {
    expect(normalizeFormFields([])).toBeNull();
    expect(normalizeFormFields(null)).toBeNull();
    expect(sameFormFields(null, normalizeFormFields([]))).toBe(true);
  });

  it("tells a changed form from the same form sent again", () => {
    const first = normalizeFormFields(
      occurrenceFormFieldsSchema.parse([
        { key: "a", label: "A", type: "text" },
      ]),
    );
    const again = normalizeFormFields(
      occurrenceFormFieldsSchema.parse([
        {
          key: "a",
          label: "A",
          type: "text",
          required: false,
          max_length: 200,
        },
      ]),
    );
    const relabelled = normalizeFormFields(
      occurrenceFormFieldsSchema.parse([
        { key: "a", label: "Outro rótulo", type: "text" },
      ]),
    );

    expect(sameFormFields(first, again)).toBe(true);
    expect(sameFormFields(first, relabelled)).toBe(false);
  });

  it("reads a stored form that no longer parses as no form", () => {
    expect(
      readFormFields([{ key: "INVALID KEY", label: "x", type: "text" }]),
    ).toBeNull();
    expect(readFormFields("not an array")).toBeNull();
    expect(readFormFields(null)).toBeNull();
  });
});

describe("the answers", () => {
  const onlyOptional: OccurrenceFormField[] = [
    { key: "obs", label: "Observação", type: "text", required: false },
  ];

  it("a type without form keeps no answers, whatever was sent", () => {
    expect(validateOccurrenceAnswers(null, { a: "x" })).toEqual({
      answers: null,
      errors: {},
    });
  });

  it("nothing answered on an optional-only form is no answers, not an error", () => {
    expect(validateOccurrenceAnswers(onlyOptional, undefined)).toEqual({
      answers: null,
      errors: {},
    });
  });

  it("a non-object body counts as no answers", () => {
    const verdict = validateOccurrenceAnswers(form, ["responsavel"]);

    expect(verdict.errors.responsavel).toBe('Preencha o campo "Quem atendeu".');
  });

  it("asks a sim/não question differently from a text one", () => {
    const verdict = validateOccurrenceAnswers(form, {});

    expect(verdict.errors.cliente_presente).toBe(
      'Responda "Cliente presente".',
    );
    expect(verdict.errors.motivo).toBe('Preencha o campo "Motivo".');
  });

  it("names the rule each answer broke", () => {
    const verdict = validateOccurrenceAnswers(form, {
      responsavel: "Maria",
      volumes: 0,
      cliente_presente: true,
      motivo: "Recusa",
      nova_data: "01/10/2026",
    });

    expect(verdict.errors).toEqual({
      volumes: '"Volumes avariados" deve ser no mínimo 1.',
      nova_data: '"Nova data" deve ser uma data válida (AAAA-MM-DD).',
    });
  });
});

describe("the answer as a person reads it", () => {
  it("formats sim/não and dates", () => {
    expect(formatOccurrenceAnswer({ type: "boolean" }, true)).toBe("Sim");
    expect(formatOccurrenceAnswer({ type: "boolean" }, false)).toBe("Não");
    expect(formatOccurrenceAnswer({ type: "date" }, "2026-10-01")).toBe(
      "01/10/2026",
    );
    expect(formatOccurrenceAnswer({ type: "number" }, 3)).toBe("3");
    expect(formatOccurrenceAnswer(undefined, "texto")).toBe("texto");
  });
});
