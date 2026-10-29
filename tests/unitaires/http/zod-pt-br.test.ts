import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  GENERIC_VALIDATION_MESSAGE,
  ptBrErrorMap,
  validationErrorMessage,
} from "@/shared/validation/zod-pt-br";

/**
 * zod's default sentences reached the clients in English ("Required",
 * "Expected boolean, received string") inside a 400 whose message was
 * "Validation Error". The map translates the defaults only.
 */
// Through the global map the module installs: a map passed to parse()
// would outrank the schemas' own required_error, which the global one never does.
const messagesOf = (schema: z.ZodTypeAny, value: unknown) => {
  const result = schema.safeParse(value);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
};

describe("ptBrErrorMap", () => {
  it("names a missing field in Portuguese", () => {
    expect(messagesOf(z.object({ page: z.number() }), {})).toEqual([
      'O campo "page" é obrigatório.',
    ]);
  });

  it("says which type was expected", () => {
    expect(
      messagesOf(z.object({ active: z.boolean() }), { active: "sim" }),
    ).toEqual(['O campo "active" deve ser verdadeiro ou falso.']);
    expect(
      messagesOf(z.object({ items: z.array(z.string()) }), { items: 1 }),
    ).toEqual(['O campo "items" deve ser uma lista.']);
  });

  it("translates sizes, formats, enums and unknown keys", () => {
    expect(
      messagesOf(z.object({ name: z.string().min(3) }), { name: "a" }),
    ).toEqual(['O campo "name" deve ter ao menos 3 caractere(s).']);
    expect(messagesOf(z.object({ n: z.number().max(5) }), { n: 9 })).toEqual([
      'O campo "n" deve ser no máximo 5.',
    ]);
    expect(
      messagesOf(z.object({ id: z.string().uuid() }), { id: "x" }),
    ).toEqual(['O campo "id" está em um formato inválido.']);
    expect(
      messagesOf(z.object({ kind: z.enum(["A", "B"]) }), { kind: "C" }),
    ).toEqual(['O campo "kind" tem um valor não aceito.']);
    expect(messagesOf(z.object({}).strict(), { extra: 1 })).toEqual([
      "Campos não aceitos: extra.",
    ]);
  });

  it("never replaces a schema's own message", () => {
    const schema = z.object({
      page: z.number({ required_error: "Informe a página." }),
      name: z.string().min(3, "Nome curto demais."),
    });

    expect(messagesOf(schema, { name: "a" })).toEqual([
      "Informe a página.",
      "Nome curto demais.",
    ]);
  });

  it("is the map installed globally when the module loads (the HTTP entry imports it)", () => {
    expect(z.getErrorMap()).toBe(ptBrErrorMap);
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
