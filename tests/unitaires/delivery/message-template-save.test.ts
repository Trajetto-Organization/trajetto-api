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
      body: "Entregue! {{link}} — para parar: {{link_descadastro}}",
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

  it("refuses a WhatsApp message with no way out", async () => {
    // A message without an opt-out is a spam complaint, and the company that
    // wrote it is not the one Meta suspends first.
    await expect(
      save({ channel: "WHATSAPP", body: "Sua entrega chegou! {{link}}" }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "MISSING_OPT_OUT_LINK",
    });
  });

  it("does not demand the opt-out link on e-mail", async () => {
    // The mail template already carries one in its own footer; demanding it in
    // the body would be asking the company to print it twice.
    await expect(save({ channel: "EMAIL" })).resolves.toBeDefined();
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
