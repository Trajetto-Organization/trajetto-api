import { beforeEach, describe, expect, it } from "vitest";

import { SaveMessageTemplateUseCase } from "@/modules/delivery/usecases/save-message-template/save-message-template-usecase";

import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * Writing the message a company sends to somebody outside it.
 *
 * Two refusals here are worth more than everything else in this file, and both
 * are refusals at SAVE time — which is the only moment validating a template
 * is worth anything at all. After that, a bad one is discovered by a customer
 * receiving a broken message days later, with nobody able to say why.
 */
const BUSINESS = "018f0000-0000-7000-8000-00000000000b";
const OTHER_BUSINESS = "018f0000-0000-7000-8000-00000000000c";

const DISPATCHER = "018f0000-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f0000-0000-7000-8000-0000000000a2";

let templates: InMemoryDeliveryMessageTemplateRepository;
let useCase: SaveMessageTemplateUseCase;

beforeEach(() => {
  const users = new InMemoryUserRepository();

  templates = new InMemoryDeliveryMessageTemplateRepository();

  users.user.push(
    { id: DISPATCHER, role: "BUSINESS_ADMIN", businessId: BUSINESS } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      driverId: "018f0000-0000-7000-8000-0000000000d1",
    } as User,
  );

  useCase = new SaveMessageTemplateUseCase(users, templates);
});

function save(overrides: Record<string, unknown> = {}) {
  return useCase.execute({
    userId: DISPATCHER,
    businessId: BUSINESS,
    topic: "DELIVERED",
    channel: "EMAIL",
    subject: "Sua entrega chegou",
    body: "Olá {{destinatario}}, sua NF {{nota}} foi entregue. {{link}}",
    is_active: true,
    ...overrides,
  } as Parameters<SaveMessageTemplateUseCase["execute"]>[0]);
}

describe("writing a message", () => {
  it("saves it for this company, moment and channel", async () => {
    const saved = await save();

    expect(saved.topic).toBe("DELIVERED");
    expect(saved.channel).toBe("EMAIL");

    expect(templates.templates).toHaveLength(1);
  });

  it("replaces the previous one instead of adding a second", async () => {
    // A second template for the same moment would make which sentence goes out
    // a matter of row order.
    await save({ body: "primeira versão {{link}}" });
    await save({ body: "segunda versão {{link}}" });

    expect(templates.templates).toHaveLength(1);
    expect(templates.templates[0].body).toContain("segunda");
  });

  it("drops a subject on WhatsApp, which carries none", async () => {
    // Storing it would show a field in the editor that never reaches anybody.
    const saved = await save({
      channel: "WHATSAPP",
      subject: "assunto que não existe no WhatsApp",
      body: undefined,
    });

    expect(saved.subject).toBeNull();
  });
});

describe("the two refusals that matter", () => {
  it("refuses a variable that does not exist", async () => {
    // The dispatcher finds out in the form. The alternative is a customer
    // receiving a message with a blank where a word should be.
    await expect(
      save({ body: "Olá {{destinatario}}, o {{motorista}} saiu {{link}}" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "UNKNOWN_TEMPLATE_VARIABLE",
    });

    expect(templates.templates).toEqual([]);
  });

  it("names the variable it refused, so the form can point at it", async () => {
    await expect(
      save({ body: "{{telefone_motorista}} {{link}}" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("{{telefone_motorista}}"),
    });
  });

  it("checks the subject too, not only the body", async () => {
    await expect(
      save({ subject: "Entrega de {{motorista}}" }),
    ).rejects.toMatchObject({ code: "UNKNOWN_TEMPLATE_VARIABLE" });
  });

  it("does not demand the opt-out link on e-mail", async () => {
    // The mail template already carries one in its own footer; demanding it in
    // the body would be asking the company to print it twice.
    await expect(save({ channel: "EMAIL" })).resolves.toBeDefined();
  });
});

/**
 * Plan of 02/11/2026, B3. A WhatsApp moment goes out as Meta's fixed
 * template, with the "Parar de receber" button built in: the company only
 * switches it on or off. The text the previous web still sends is ignored —
 * never refused, so that web keeps saving during the rolling deploy — and the
 * column is never written NULL in this release (nullable-expand: the image
 * before this one still reads a WhatsApp row's body as a string).
 */
describe("a WhatsApp moment is an on/off switch", () => {
  it("saves the switch with no text at all", async () => {
    const saved = await save({
      channel: "WHATSAPP",
      subject: null,
      body: undefined,
      is_active: false,
    });

    expect(saved.is_active).toBe(false);
    expect(saved.subject).toBeNull();

    // Never NULL in this release.
    expect(templates.templates[0].body).toBe("");
  });

  it("ignores the text the previous web still sends, opt-out link or not", async () => {
    await expect(
      save({
        channel: "WHATSAPP",
        body: "Sua entrega chegou! {{link}} {{motorista}}",
      }),
    ).resolves.toMatchObject({ is_active: true });

    expect(templates.templates[0].body).toBe("");
  });

  it("keeps the text a WhatsApp row already had", async () => {
    await save({ channel: "WHATSAPP", body: undefined });

    templates.templates[0].body = "texto antigo {{link_descadastro}}";

    await save({ channel: "WHATSAPP", body: "outro", is_active: false });

    expect(templates.templates).toHaveLength(1);
    expect(templates.templates[0].body).toBe(
      "texto antigo {{link_descadastro}}",
    );
    expect(templates.templates[0].is_active).toBe(false);
  });

  it("still demands the text of an e-mail", async () => {
    await expect(
      save({ channel: "EMAIL", body: undefined }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "TEMPLATE_BODY_REQUIRED",
    });

    expect(templates.templates).toEqual([]);
  });
});

describe("who may write it", () => {
  it("refuses a driver", async () => {
    await expect(save({ userId: DRIVER_USER })).rejects.toMatchObject({
      code: "DRIVER_CANNOT_MANAGE_DELIVERIES",
    });
  });

  it("refuses another company's", async () => {
    await expect(save({ businessId: OTHER_BUSINESS })).rejects.toBeTruthy();

    expect(templates.templates).toEqual([]);
  });
});
