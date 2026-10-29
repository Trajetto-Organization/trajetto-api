import { describe, expect, it } from "vitest";
import { TENANT_MOVE_REFUSED } from "@/shared/validation/tenant-locked-field";
import type { ZodTypeAny } from "zod";

import { createUserSchema } from "@/schemas/create-user-schema";
import { updateUserSchema } from "@/schemas/update-user-schema";
import { createAccountPayableSchema } from "@/schemas/create-account-payable-schema";
import { updateAccountPayableSchema } from "@/schemas/update-account-payable-schema";
import { createPartSchema } from "@/schemas/create-part-schema";

/**
 * The bodies of the main create/update forms that had no schema test
 * (TEST-UC-1): what passes, what is refused and with which pt-BR sentence.
 * The web mirrors these schemas; a change here without the same change
 * there is a form that submits what the API refuses.
 */
const UUID = "018f0000-0000-7000-8000-000000000001";
const OTHER_UUID = "018f0000-0000-7000-8000-000000000002";

function messages(schema: ZodTypeAny, body: unknown): string[] {
  const result = schema.safeParse(body);

  return result.success
    ? []
    : result.error.issues.map((issue) => issue.message);
}

describe("createUserSchema", () => {
  const base = {
    email: "ana.souza@transportadora.com.br",
    name: "Ana Souza",
    role: "BUSINESS_USER",
    businessId: UUID,
    profileAccessId: OTHER_UUID,
  };

  it("accepts an operator with an access profile, and an admin with neither link", () => {
    expect(messages(createUserSchema, base)).toEqual([]);
    expect(
      messages(createUserSchema, {
        ...base,
        role: "BUSINESS_ADMIN",
        profileAccessId: "",
      }),
    ).toEqual([]);
  });

  it("asks for the full name, without edge or repeated spaces", () => {
    expect(messages(createUserSchema, { ...base, name: "Ana" })).toEqual([
      "Por favor, insira o nome de usuário completo.",
    ]);
    expect(messages(createUserSchema, { ...base, name: " Ana Souza" })).toEqual(
      ["O nome de usuário não pode começar ou terminar com espaço em branco."],
    );
    expect(messages(createUserSchema, { ...base, name: "Ana  Souza" })).toEqual(
      ["O nome de usuário não deve conter espaços consecutivos."],
    );
    expect(
      messages(createUserSchema, { ...base, name: `Ana ${"a".repeat(97)}` }),
    ).toEqual(["O nome de usuário não deve exceder 100 caracteres."]);
  });

  it("refuses an operator with both links, or with none", () => {
    expect(messages(createUserSchema, { ...base, driverId: UUID })).toEqual([
      "Usuário não pode ter tanto um perfil de acesso quanto um motorista vinculado. Escolha apenas um.",
    ]);
    expect(
      messages(createUserSchema, { ...base, profileAccessId: "" }),
    ).toEqual(["Selecione um perfil de acesso!"]);
    expect(
      messages(createUserSchema, {
        ...base,
        profileAccessId: "",
        userType: "driver",
      }),
    ).toEqual(["Selecione um motorista!"]);
  });

  it("refuses an admin carrying a profile, an invalid e-mail and a role outside the company's", () => {
    expect(
      messages(createUserSchema, { ...base, role: "BUSINESS_ADMIN" }),
    ).toEqual([
      "Administrador de empresa não deve ter perfil de acesso ou motorista vinculado.",
    ]);
    expect(messages(createUserSchema, { ...base, email: "ana@" })).toEqual([
      "O e-mail informado não é válido.",
    ]);
    // MASTER is created through its own route, never by a company form.
    expect(messages(createUserSchema, { ...base, role: "MASTER" })[0]).toMatch(
      /^Nível de acesso do usuário inválido/,
    );
  });

  it("never carries a password: the user sets it from a single-use link (decision 4.9)", () => {
    const parsed = createUserSchema.parse({ ...base, password: "Senha@123" });

    expect(parsed).not.toHaveProperty("password");
  });
});

describe("updateUserSchema", () => {
  it("treats an empty field as unchanged, not as a value", () => {
    const parsed = updateUserSchema.parse({ email: "", name: "" });

    expect(parsed.email).toBeNull();
    expect(parsed.name).toBeNull();
  });

  it("still refuses both links when the role is not sent", () => {
    expect(
      messages(updateUserSchema, {
        profileAccessId: UUID,
        driverId: OTHER_UUID,
      }),
    ).toEqual([
      "Usuário não pode ter tanto um perfil de acesso quanto um motorista vinculado. Escolha apenas um.",
    ]);
  });

  // Decision 16.100: no edit moves a person between companies, whatever the value.
  it.each(["empresa-1", "018f0000-0000-7000-8000-00000000000a"])(
    "refuses any company id (%s)",
    (businessId) => {
      expect(messages(updateUserSchema, { businessId })).toEqual([
        TENANT_MOVE_REFUSED,
      ]);
    },
  );
});

describe("createAccountPayableSchema", () => {
  const base = {
    category: "FUEL",
    due_date: "2026-10-10",
    amount: 150.5,
    branchId: UUID,
    registrationUserId: OTHER_UUID,
    payee_name: "Posto Central",
  };

  it("accepts a bill with a free-text payee and clears a stray category description", () => {
    const parsed = createAccountPayableSchema.parse({
      ...base,
      category_description: "x",
    });

    expect(parsed.category_description).toBeNull();
  });

  it("refuses a day that does not exist instead of rolling it over", () => {
    expect(
      messages(createAccountPayableSchema, { ...base, due_date: "2026-02-30" }),
    ).toEqual(["Data de vencimento inválida."]);
  });

  it("asks for exactly one payee", () => {
    expect(
      messages(createAccountPayableSchema, { ...base, payee_name: "" }),
    ).toEqual(["Informe o favorecido: um fornecedor cadastrado ou um nome."]);
    expect(
      messages(createAccountPayableSchema, { ...base, supplierId: UUID }),
    ).toEqual([
      "Informe o fornecedor cadastrado ou o nome do favorecido, não os dois.",
    ]);
  });

  it("keeps payment date and amount paid together, never above the total", () => {
    const refusal =
      "Se há data de pagamento, deve haver valor pago e vice-versa. O valor pago não pode ser maior que o valor total.";

    expect(
      messages(createAccountPayableSchema, {
        ...base,
        payment_date: "2026-10-09",
      }),
    ).toEqual([refusal]);
    expect(
      messages(createAccountPayableSchema, {
        ...base,
        payment_date: "2026-10-09",
        amount_paid: 200,
      }),
    ).toEqual([refusal]);
    expect(
      messages(createAccountPayableSchema, {
        ...base,
        payment_date: "2026-10-09",
        amount_paid: 150.5,
      }),
    ).toEqual([]);
  });

  it("holds the amount between R$ 1,00 and R$ 9.999.999,99", () => {
    expect(
      messages(createAccountPayableSchema, { ...base, amount: 0.99 }),
    ).toEqual(["O valor deve ser no mínimo R$ 1,00"]);
    expect(
      messages(createAccountPayableSchema, { ...base, amount: 9999999.99 }),
    ).toEqual([]);
    expect(
      messages(createAccountPayableSchema, { ...base, amount: 10000000 }),
    ).toEqual(["O valor não pode exceder R$ 9.999.999,99."]);
  });

  it("asks for a description when the category is OTHER", () => {
    expect(
      messages(createAccountPayableSchema, { ...base, category: "OTHER" }),
    ).toEqual(['Descreva a categoria ao selecionar "Outros".']);
  });
});

describe("updateAccountPayableSchema", () => {
  it("accepts an empty body: every field absent is unchanged", () => {
    expect(messages(updateAccountPayableSchema, {})).toEqual([]);
  });

  it("does not let a required column be cleared with null", () => {
    expect(
      messages(updateAccountPayableSchema, { amount: null }).length,
    ).toBeGreaterThan(0);
    expect(
      messages(updateAccountPayableSchema, { due_date: null }).length,
    ).toBeGreaterThan(0);
  });
});

describe("createPartSchema", () => {
  const base = {
    description: "Filtro de óleo",
    unit_price: 89.9,
    supplierId: "",
  };

  it("accepts a part without supplier, an empty supplier meaning none", () => {
    expect(createPartSchema.parse(base).supplierId).toBeNull();
  });

  it("refuses a short or padded name and a price out of range", () => {
    expect(messages(createPartSchema, { ...base, description: "Fi" })).toEqual([
      "A descrição deve ter no mínimo 3 caracteres.",
    ]);
    expect(
      messages(createPartSchema, { ...base, description: "Filtro " }),
    ).toEqual(["O nome não pode começar ou terminar com espaço em branco."]);
    expect(messages(createPartSchema, { ...base, unit_price: 0 })).toEqual([
      "O preço unitário deve ser um valor positivo.",
    ]);
    expect(
      messages(createPartSchema, { ...base, unit_price: 1_000_000 }),
    ).toEqual(["O preço unitário não pode exceder 999.999,99."]);
  });
});
