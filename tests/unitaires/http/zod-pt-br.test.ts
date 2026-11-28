import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  GENERIC_VALIDATION_MESSAGE,
  ptBrError,
  validationErrorMessage,
  validationIssueSentences,
} from "@/shared/validation/zod-pt-br";
import { fieldError } from "@/shared/validation/field-error";

/**
 * zod's default sentences reached the clients in English ("Required",
 * "Expected boolean, received string") inside a 400 whose message was
 * "Validation Error". The map translates the defaults only.
 */
// Through the global map the module installs: a map passed to parse()
// would outrank the global one, and a schema's own error outranks both.
const messagesOf = (schema: z.ZodType, value: unknown) => {
  const result = schema.safeParse(value);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe("ptBrError", () => {
  it("names a missing field in Portuguese", () => {
    expect(messagesOf(z.object({ page: z.number() }), {})).toEqual([
      'O campo "page" é obrigatório.',
    ]);
    // zod 4 reports a missing enum as a value off the list.
    expect(messagesOf(z.object({ kind: z.enum(["A", "B"]) }), {})).toEqual([
      'O campo "kind" é obrigatório.',
    ]);
  });

  it("says which type was expected", () => {
    expect(
      messagesOf(z.object({ active: z.boolean() }), { active: "sim" }),
    ).toEqual(['O campo "active" deve ser verdadeiro ou falso.']);
    expect(
      messagesOf(z.object({ items: z.array(z.string()) }), { items: 1 }),
    ).toEqual(['O campo "items" deve ser uma lista.']);
    expect(messagesOf(z.object({ n: z.number().int() }), { n: 1.5 })).toEqual([
      'O campo "n" deve ser um número inteiro.',
    ]);
  });

  // One code in zod 4 for what zod 3 told apart: the sentences stay.
  it("keeps zod 3's sentences for an invalid date and a non-finite number", () => {
    expect(
      messagesOf(z.object({ at: z.coerce.date() }), { at: "ontem" }),
    ).toEqual(['O campo "at" deve ser uma data válida.']);
    expect(
      messagesOf(z.object({ n: z.coerce.number() }), { n: "1e999" }),
    ).toEqual(['O campo "n" deve ser um número finito.']);
  });

  it("translates sizes, formats, enums and unknown keys", () => {
    expect(
      messagesOf(z.object({ name: z.string().min(3) }), { name: "a" }),
    ).toEqual(['O campo "name" deve ter ao menos 3 caractere(s).']);
    expect(
      messagesOf(z.object({ tags: z.array(z.string()).max(1) }), {
        tags: ["a", "b"],
      }),
    ).toEqual(['O campo "tags" deve ter no máximo 1 item(ns).']);
    expect(messagesOf(z.object({ n: z.number().max(5) }), { n: 9 })).toEqual([
      'O campo "n" deve ser no máximo 5.',
    ]);
    expect(
      messagesOf(z.object({ n: z.number().positive() }), { n: 0 }),
    ).toEqual(['O campo "n" deve ser maior que 0.']);
    expect(
      messagesOf(z.object({ id: z.string().uuid() }), { id: "x" }),
    ).toEqual(['O campo "id" está em um formato inválido.']);
    expect(
      messagesOf(z.object({ kind: z.enum(["A", "B"]) }), { kind: "C" }),
    ).toEqual(['O campo "kind" tem um valor não aceito.']);
    expect(
      messagesOf(z.object({ kind: z.literal("A") }), { kind: "B" }),
    ).toEqual(['O campo "kind" tem um valor não aceito.']);
    expect(
      messagesOf(z.object({ v: z.union([z.string(), z.number()]) }), {
        v: true,
      }),
    ).toEqual(['O campo "v" tem um valor não aceito.']);
    expect(messagesOf(z.object({}).strict(), { extra: 1 })).toEqual([
      "Campos não aceitos: extra.",
    ]);
    expect(
      messagesOf(z.object({ n: z.number().multipleOf(5) }), { n: 7 }),
    ).toEqual(['O campo "n" deve ser múltiplo de 5.']);
    expect(
      messagesOf(z.object({ n: z.number().refine((value) => value > 1) }), {
        n: 0,
      }),
    ).toEqual(['O campo "n" é inválido.']);
  });

  // zod 4 wraps a refused record key in `invalid_key`, whose own sentence is
  // the locale's English ("Invalid key in record"); zod 3 reported the key's
  // issue itself, at the entry's path.
  it("names a refused record key at the entry's path, as zod 3 did", () => {
    expect(
      messagesOf(z.object({ a: z.record(z.string().max(3), z.string()) }), {
        a: { abcd: "x" },
      }),
    ).toEqual(['O campo "a.abcd" deve ter no máximo 3 caractere(s).']);
    expect(
      messagesOf(
        z.object({
          a: z.record(z.string().max(3, "Chave longa."), z.string()),
        }),
        { a: { abcd: "x" } },
      ),
    ).toEqual(["Chave longa."]);
    // A Map's object key has no path to name: the inner sentence stays.
    expect(
      messagesOf(z.map(z.number(), z.string()), new Map([[{}, "y"]])),
    ).toEqual(["O valor deve ser um número."]);
  });

  it("never replaces a schema's own message", () => {
    const schema = z.object({
      page: z.number(fieldError({ required: "Informe a página." })),
      name: z.string().min(3, "Nome curto demais."),
    });

    expect(messagesOf(schema, { name: "a" })).toEqual([
      "Informe a página.",
      "Nome curto demais.",
    ]);
  });

  it("is the map installed globally when the module loads (the HTTP entry imports it)", () => {
    expect(z.config().customError).toBe(ptBrError);
  });
});

/**
 * zod 4 has one `error` option where zod 3 had `required_error` and
 * `invalid_type_error`; fieldError answers what the two did, and only that.
 */
describe("fieldError", () => {
  const schema = z.object({
    km: z
      .number(
        fieldError({
          required: "Informe a quilometragem.",
          invalid: "A quilometragem deve ser um número.",
        }),
      )
      .int()
      .max(10),
    kind: z.enum(
      ["A", "B"],
      fieldError({ required: "Informe o tipo.", invalid: "Tipo inválido." }),
    ),
    note: z.string(fieldError({ required: "Informe a nota." })).max(3),
  });

  it("tells a missing field from a wrong one", () => {
    expect(messagesOf(schema, {})).toEqual([
      "Informe a quilometragem.",
      "Informe o tipo.",
      "Informe a nota.",
    ]);
    expect(messagesOf(schema, { km: "dez", kind: 1, note: 2 })).toEqual([
      "A quilometragem deve ser um número.",
      "Tipo inválido.",
      'O campo "note" deve ser um texto.',
    ]);
  });

  it("answers .int() as zod 3's invalid_type_error did, and an enum value off the list", () => {
    expect(messagesOf(schema, { km: 1.5, kind: "C", note: "a" })).toEqual([
      "A quilometragem deve ser um número.",
      "Tipo inválido.",
    ]);
  });

  it("leaves a bare check to the pt-BR defaults", () => {
    expect(messagesOf(schema, { km: 11, kind: "A", note: "abcd" })).toEqual([
      'O campo "km" deve ser no máximo 10.',
      'O campo "note" deve ter no máximo 3 caractere(s).',
    ]);
  });
});

describe("validationErrorMessage", () => {
  it("is the first sentence, or a generic Portuguese one", () => {
    expect(
      validationErrorMessage(["A data é inválida.", "O CEP é obrigatório."]),
    ).toBe("A data é inválida.");
    expect(validationErrorMessage([])).toBe(GENERIC_VALIDATION_MESSAGE);
    expect(validationErrorMessage(["  "])).toBe(GENERIC_VALIDATION_MESSAGE);
  });
});

/**
 * zod 4 still runs a length check on a value of the wrong type when the
 * value has a length; zod 3 stopped at the type. The 400 keeps zod 3's list.
 */
describe("validationIssueSentences", () => {
  const sentencesOf = (schema: z.ZodType, value: unknown) => {
    const result = schema.safeParse(value);

    return result.success
      ? []
      : validationIssueSentences(
          result.error.issues.map(({ code, path, message }) => ({
            code,
            path: path.map(String).join("/"),
            message,
          })),
        );
  };

  it("says nothing more of a field after its wrong type", () => {
    const schema = z.object({
      name: z.string().min(2, "Nome curto."),
      items: z.array(z.string()).max(2, "Itens demais."),
    });

    // Without the filter: "deve ser um texto" AND "Nome curto." (an array
    // has a length), "deve ser uma lista" AND "Itens demais.".
    expect(sentencesOf(schema, { name: ["a"], items: "abc" })).toEqual([
      'O campo "name" deve ser um texto.',
      'O campo "items" deve ser uma lista.',
    ]);
  });

  it("keeps every sentence of a value of the right type, and of other fields", () => {
    const schema = z.object({
      name: z
        .string()
        .min(2, "Nome curto.")
        .regex(/^[a-z]+$/, "Só letras."),
      age: z.number(),
    });

    expect(sentencesOf(schema, { name: "1", age: "x" })).toEqual([
      "Nome curto.",
      "Só letras.",
      'O campo "age" deve ser um número.',
    ]);
  });
});
