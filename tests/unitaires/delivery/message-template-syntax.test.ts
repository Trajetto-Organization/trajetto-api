import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SaveMessageTemplateUseCase } from "@/modules/delivery/usecases/save-message-template/save-message-template-usecase";

import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import * as messageTemplate from "@/shared/delivery/message-template";
import {
  renderDeliveryMessage,
  type DeliveryMessageVariables,
} from "@/shared/delivery/message-template";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * The template language a company may write in, and nothing more.
 *
 * The save used to check one thing — a regex for `{{name}}` — and never
 * parsed the body. Everything else Handlebars understands went straight to
 * the database: partials, blocks, helpers with arguments. At send time it
 * either could not render (an unclosed `{{#if}}` is a parse error, a partial
 * is "could not be found") and burned five retries per customer before
 * failing, or it rendered and did something no message should: `{{log}}`
 * writes an arbitrary line — `[ERROR] ...` — into the platform's shared log
 * stream, once per send, from any tenant.
 *
 * The language is closed on purpose: text, comments, and the published
 * variables. That is what the editor documents and what the catalogue uses.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";

let templates: InMemoryDeliveryMessageTemplateRepository;
let useCase: SaveMessageTemplateUseCase;

beforeEach(() => {
  const users = new InMemoryUserRepository();

  templates = new InMemoryDeliveryMessageTemplateRepository();

  users.user.push({
    id: DISPATCHER,
    role: "BUSINESS_ADMIN",
    businessId: BUSINESS,
  } as User);

  useCase = new SaveMessageTemplateUseCase(users, templates);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function save(overrides: Record<string, unknown> = {}) {
  return useCase.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    topic: "DISPATCHED",
    channel: "EMAIL",
    subject: "Sua entrega saiu",
    body: "Olá {{destinatario}}, acompanhe: {{link}}",
    is_active: true,
    ...overrides,
  } as Parameters<SaveMessageTemplateUseCase["execute"]>[0]);
}

const VARIABLES: DeliveryMessageVariables = {
  destinatario: "Padaria Central",
  transportadora: "Café & Cia Transportes",
  nota: "12345",
  pedido: "PED-1",
  cidade: "São Paulo",
  uf: "SP",
  previsao: "16/09/2026",
  data_entrega: "",
  recebido_por: "",
  link: "https://app.exemplo/acompanhar/abc",
  link_descadastro: "https://app.exemplo/acompanhar/abc/parar",
};

describe("saving a template the product cannot render", () => {
  it("refuses a partial", async () => {
    await expect(
      save({ body: "Olá {{destinatario}}, {{> cabecalho}} {{link}}" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "UNSUPPORTED_TEMPLATE_SYNTAX",
    });

    expect(templates.templates).toEqual([]);
  });

  it("refuses a block left open, as a syntax error the form can show", async () => {
    await expect(
      save({ body: "Oi {{#if destinatario}} {{destinatario}} {{link}}" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_TEMPLATE_SYNTAX",
    });

    expect(templates.templates).toEqual([]);
  });

  it("refuses an unclosed mustache", async () => {
    await expect(
      save({ body: "Olá {{destinatario, acompanhe {{link}}" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "INVALID_TEMPLATE_SYNTAX",
    });
  });

  it("refuses the log helper, which would write into the platform's log", async () => {
    await expect(
      save({
        body: '{{log "[ERROR] FORGED: pagamento estornado" level="error"}} {{link}}',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "UNSUPPORTED_TEMPLATE_SYNTAX",
    });

    expect(templates.templates).toEqual([]);
  });

  it.each([
    ['{{lookup this "destinatario"}}'],
    ["{{./destinatario}}"],
    ["{{this.destinatario}}"],
    ["{{destinatario.length}}"],
    ["{{@root}}"],
    ["{{#if destinatario}}{{destinatario}}{{/if}}"],
    ["{{#each destinatario}}x{{/each}}"],
    ["{{* decorador}}"],
  ])("refuses %s", async (fragment) => {
    await expect(
      save({ body: `${fragment} {{link}}` }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "UNSUPPORTED_TEMPLATE_SYNTAX",
    });
  });

  it("names what it refused without echoing the arguments", async () => {
    const refusal = save({
      body: '{{log "[ERROR] FORGED" level="error"}} {{link}}',
    });

    await expect(refusal).rejects.toMatchObject({
      message: expect.stringContaining("{{log}}"),
    });

    await expect(refusal).rejects.toMatchObject({
      message: expect.not.stringContaining("FORGED"),
    });
  });

  it("checks the subject too, not only the body", async () => {
    await expect(
      save({ subject: "{{#if nota}}NF {{nota}}{{/if}}" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_TEMPLATE_SYNTAX" });
  });

  it("still refuses an unknown variable with its own code", async () => {
    await expect(
      save({ body: "Olá {{motorista}} {{link}}" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE" });
  });
});

describe("what a company may still write", () => {
  it("accepts comments, whitespace control and the unescaped form", async () => {
    await save({
      body: "{{! lembrete interno }}Olá {{~destinatario~}}! {{{link}}} {{ nota }}",
    });

    expect(templates.templates).toHaveLength(1);
  });

  it("accepts a literal brace that is not a mustache", async () => {
    await save({ body: "Pedido }} confirmado. {{link}}" });

    expect(templates.templates).toHaveLength(1);
  });
});

describe("the WhatsApp opt-out", () => {
  it("does not count a link hidden inside a comment", async () => {
    // The old check was `body.includes("{{link_descadastro}}")`, which a
    // comment satisfies while the customer receives no way out at all.
    await expect(
      save({
        channel: "WHATSAPP",
        body: "{{!-- {{link_descadastro}} --}} Saiu: {{link}}",
      }),
    ).rejects.toMatchObject({ code: "MISSING_OPT_OUT_LINK" });
  });

  it("counts the link however it is spaced", async () => {
    await save({
      channel: "WHATSAPP",
      body: "Saiu: {{link}} — parar: {{ link_descadastro }}",
    });

    expect(templates.templates).toHaveLength(1);
  });
});

describe("rendering a template that slipped past the save", () => {
  it("fails with a template error, not a generic one the pipeline retries", () => {
    const { InvalidMessageTemplateError } = messageTemplate as unknown as {
      InvalidMessageTemplateError?: new (...args: never[]) => Error;
    };

    expect(InvalidMessageTemplateError).toBeTypeOf("function");

    expect(() =>
      renderDeliveryMessage("{{#if destinatario}}x", VARIABLES),
    ).toThrow(InvalidMessageTemplateError!);

    expect(() =>
      renderDeliveryMessage("{{> cabecalho}} {{link}}", VARIABLES),
    ).toThrow(InvalidMessageTemplateError!);
  });

  it("never runs the log helper", () => {
    const printed = [
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];

    expect(() =>
      renderDeliveryMessage(
        '{{log "[ERROR] FORGED" level="error"}} {{link}}',
        VARIABLES,
      ),
    ).toThrow();

    for (const spy of printed) expect(spy).not.toHaveBeenCalled();
  });

  it("still renders an ordinary template, unescaped", () => {
    expect(
      renderDeliveryMessage(
        "{{transportadora}} para {{destinatario}}: {{link}}",
        VARIABLES,
      ),
    ).toBe(
      "Café & Cia Transportes para Padaria Central: https://app.exemplo/acompanhar/abc",
    );
  });
});
