import { describe, expect, it } from "vitest";

import { notificationPolicies } from "@/shared/notifications/notification-policy";
import {
  INTERNAL_WHATSAPP_TEMPLATES,
  WHATSAPP_BODY_LIMIT,
  WhatsAppTemplateMismatchError,
  bodyVariableCount,
  fitParameter,
  fitTemplateParameters,
  fixedTextLength,
  prepareInternalWhatsApp,
  type WhatsAppTemplateDefinition,
} from "@/shared/notifications/whatsapp-templates";
import {
  CUSTOMER_WHATSAPP_TEMPLATES,
  buildCustomerWhatsApp,
  customerWhatsAppPreview,
  deliveryReference,
} from "@/shared/delivery/customer-whatsapp-templates";

import type {
  NotificationTopic,
  RecipientRenderContext,
} from "@/shared/notifications/notification-types";

/**
 * The WhatsApp templates (plan of 02/11/2026, B1/B2): one registry the
 * renders, the send, the body guard and /health/providers all read.
 *
 * Every internal notice used to go out under one generic template with the
 * whole text in a single parameter — Meta filed it as Marketing — and the
 * customer's message was the company's free text in that same parameter.
 * What is proven here is what Meta would otherwise refuse at send time, on
 * every message, permanently: a wrong parameter count (132000), an empty
 * parameter (131008/100), a body over 1024 (132005), and a body Meta does not
 * accept for review (a variable at an edge or two in a row).
 */
const INTERNAL: WhatsAppTemplateDefinition[] = Object.values(
  INTERNAL_WHATSAPP_TEMPLATES,
);
const CUSTOMER: WhatsAppTemplateDefinition[] = Object.values(
  CUSTOMER_WHATSAPP_TEMPLATES,
);
const ALL = [...INTERNAL, ...CUSTOMER];

describe("the registry", () => {
  it("holds the 17 internal templates the owner creates at Meta, by their exact names", () => {
    expect(INTERNAL.map((template) => template.name).sort()).toEqual(
      [
        "trajetto_entrega_insucesso",
        "trajetto_autorizacao_ocorrencia",
        "trajetto_autorizacao_entrega",
        "trajetto_autorizacao_sem_resposta",
        "trajetto_multa_registrada",
        "trajetto_ordem_servico",
        "trajetto_conta_pagar",
        "trajetto_kanban_card_criado",
        "trajetto_kanban_card_atualizado",
        "trajetto_modulo_plano",
        "trajetto_modulo_habilitado_empresa",
        "trajetto_modulo_desabilitado_empresa",
        "trajetto_limite_plano",
        "trajetto_limite_plano_empresa",
        "trajetto_master_criado",
        "trajetto_master_atualizado",
        "trajetto_conta_master_atualizada",
      ].sort(),
    );
  });

  it("holds the customer's four, one per moment, by their exact names", () => {
    expect(
      Object.fromEntries(
        Object.entries(CUSTOMER_WHATSAPP_TEMPLATES).map(([topic, template]) => [
          topic,
          template.name,
        ]),
      ),
    ).toEqual({
      DISPATCHED: "trajetto_cliente_saiu_para_entrega",
      ON_THE_WAY: "trajetto_cliente_a_caminho",
      DELIVERED: "trajetto_cliente_entregue",
      // The names of the approved plan (B2), as the owner creates them at Meta.
      FAILED: "trajetto_cliente_insucesso",
    });
  });

  it("keeps the parameter count and the URL buttons the owner created at Meta", () => {
    // Created at Meta on 03/11/2026 from docs/whatsapp-modelos.md. A send
    // with another count is Meta's 132000 on every message, permanently, so
    // a body edited here that changes it must first be re-reviewed there.
    const created = Object.fromEntries(
      ALL.map((template) => [
        template.name,
        [template.variables.length, template.buttons?.length ?? 0],
      ]),
    );

    expect(created).toEqual({
      trajetto_entrega_insucesso: [5, 0],
      trajetto_autorizacao_ocorrencia: [5, 0],
      trajetto_autorizacao_entrega: [5, 0],
      trajetto_autorizacao_sem_resposta: [4, 0],
      trajetto_multa_registrada: [11, 0],
      trajetto_ordem_servico: [7, 0],
      trajetto_conta_pagar: [6, 0],
      trajetto_kanban_card_criado: [4, 0],
      trajetto_kanban_card_atualizado: [4, 0],
      trajetto_modulo_plano: [4, 0],
      trajetto_modulo_habilitado_empresa: [2, 0],
      trajetto_modulo_desabilitado_empresa: [2, 0],
      trajetto_limite_plano: [5, 0],
      trajetto_limite_plano_empresa: [4, 0],
      trajetto_master_criado: [2, 0],
      trajetto_master_atualizado: [2, 0],
      trajetto_conta_master_atualizada: [2, 0],
      trajetto_cliente_saiu_para_entrega: [3, 2],
      trajetto_cliente_a_caminho: [3, 2],
      trajetto_cliente_entregue: [4, 2],
      trajetto_cliente_insucesso: [3, 2],
    });

    // Both customer buttons end in the tracking token, the URL's one variable.
    for (const template of CUSTOMER) {
      expect(template.buttons?.map((button) => button.path)).toEqual([
        "acompanhar/{{1}}",
        "parar/{{1}}",
      ]);
    }
  });

  it("never names the retired generic template", () => {
    expect(ALL.map((template) => template.name)).not.toContain(
      "trajetto_notification",
    );
  });
});

describe.each(ALL.map((template) => [template.name, template] as const))(
  "%s, as Meta reviews it",
  (_name, template) => {
    it("numbers its variables 1..n, one per registry entry", () => {
      const numbers = [
        ...new Set(
          (template.body.match(/\{\{(\d+)\}\}/g) ?? []).map((match) =>
            Number(match.slice(2, -2)),
          ),
        ),
      ].sort((a, b) => a - b);

      expect(numbers).toEqual(
        template.variables.map((_variable, index) => index + 1),
      );
      expect(bodyVariableCount(template.body)).toBe(template.variables.length);
    });

    it("starts and ends with fixed text, never two variables in a row", () => {
      expect(template.body.trimStart().startsWith("{{")).toBe(false);
      expect(template.body.trimEnd().endsWith("}}")).toBe(false);
      expect(template.body).not.toMatch(/\}\}\s*\{\{/);
    });

    it("has no bold and no emoji in its fixed text", () => {
      const fixed = template.body.replace(/\{\{\d+\}\}/g, "");

      expect(fixed).not.toContain("*");
      expect(fixed).not.toMatch(/\p{Extended_Pictographic}/u);
    });

    it("stays under 1024 characters even with every value past its limit", () => {
      const worst = fitTemplateParameters(
        template,
        template.variables.map((variable) => "x ".repeat(variable.max + 50)),
      );

      const total =
        fixedTextLength(template) +
        worst.reduce((sum, value) => sum + value.length, 0);

      expect(total).toBeLessThanOrEqual(WHATSAPP_BODY_LIMIT);
    });

    it("fills every variable with its fallback when nothing is known", () => {
      const empty = fitTemplateParameters(
        template,
        template.variables.map(() => null),
      );

      expect(empty).toEqual(
        template.variables.map((variable) => variable.fallback),
      );

      for (const value of empty) expect(value.trim()).not.toBe("");
    });
  },
);

describe("fitting a parameter", () => {
  const variable = {
    meaning: "x",
    max: 10,
    fallback: "não informado",
    sample: "",
  };

  it("puts it on one line: Meta refuses newlines, tabs and runs of spaces", () => {
    expect(fitParameter("a\n\tb    c", variable)).toBe("a b c");
  });

  it("cuts it at the variable's limit with an ellipsis", () => {
    const fitted = fitParameter("abcdefghijklmnop", variable);

    expect(fitted).toBe("abcdefghi…");
    expect(fitted.length).toBe(10);
  });

  it("never sends an empty one: blanks become the fallback", () => {
    expect(fitParameter(null, variable)).toBe("não informado");
    expect(fitParameter(undefined, variable)).toBe("não informado");
    expect(fitParameter(" \n ", variable)).toBe("não informado");
  });

  it("refuses a render with the wrong number of parameters", () => {
    expect(() =>
      prepareInternalWhatsApp({
        template: "trajetto_master_criado",
        parameters: ["só um"],
      }),
    ).toThrow(WhatsAppTemplateMismatchError);
  });
});

/**
 * Each internal topic's render, for each audience it speaks to: the template
 * it names exists in the registry and the parameters, once fitted, are
 * exactly as many as the template takes, none empty — with full payloads and
 * with everything optional missing (an event queued before the new fields).
 */
const MASTER: RecipientRenderContext = { id: "m-2", role: "MASTER" };
const ADMIN: RecipientRenderContext = { id: "a-1", role: "BUSINESS_ADMIN" };
const DRIVER: RecipientRenderContext = {
  id: "d-1",
  role: "BUSINESS_USER",
  driverId: "drv-1",
};

const actor = {
  id: "u-1",
  name: "Fernanda Lopes",
  email: "fernanda@exemplo.com.br",
  role: "MASTER",
};

const cases: Array<
  [NotificationTopic, Record<string, unknown>, RecipientRenderContext, string]
> = [
  [
    "delivery-occurrence.reported",
    {
      deliveryId: "d",
      businessId: "b",
      recipientName: "Mercado",
      occurrenceTypeName: "Cliente ausente",
      blocksDelivery: true,
      description: null,
      photosCount: 0,
      reporterName: "João",
      deliveryStatusAfter: "Insucesso",
    },
    ADMIN,
    "trajetto_entrega_insucesso",
  ],
  [
    "delivery-occurrence.authorization_requested",
    {
      occurrenceId: "o",
      deliveryId: "d",
      businessId: "b",
      recipientName: "Mercado",
      occurrenceTypeName: "Recusa",
      blocksDelivery: true,
      description: null,
      reporterName: "João",
      photosCount: 0,
      answers: [],
      requestedAt: "2026-11-03T12:00:00.000Z",
    },
    ADMIN,
    "trajetto_autorizacao_ocorrencia",
  ],
  [
    "delivery-occurrence.authorization_requested",
    {
      occurrenceId: "o",
      deliveryId: "d",
      businessId: "b",
      recipientName: "Mercado",
      occurrenceTypeName: "Entregue a vizinho",
      blocksDelivery: false,
      description: "Vizinha recebeu",
      reporterName: "João",
      fromDriver: false,
      photosCount: 1,
      answers: [{ label: "Quem", value: "Ana" }],
      requestedAt: "2026-11-03T12:00:00.000Z",
      category: "DELIVERED",
    },
    ADMIN,
    "trajetto_autorizacao_entrega",
  ],
  [
    "delivery-occurrence.authorization_escalated",
    {
      occurrenceId: "o",
      deliveryId: "d",
      businessId: "b",
      recipientName: "Mercado",
      occurrenceTypeName: "Recusa",
      blocksDelivery: true,
      description: null,
      reporterName: "João",
      photosCount: 0,
      answers: [],
      requestedAt: "2026-11-03T12:00:00.000Z",
      waitingMinutes: 12,
    },
    ADMIN,
    "trajetto_autorizacao_sem_resposta",
  ],
  [
    "fine.created",
    {
      fineId: "f",
      businessId: "b",
      amount: 130.16,
      points: null,
      violationDate: "2026-10-14T12:00:00.000Z",
      location: null,
      observation: null,
      vehiclePlate: "RTA4F21",
      driverName: "Carlos",
      branchName: "Filial",
      violationCode: "745-50",
      actor: { ...actor, role: "BUSINESS_ADMIN", email: null },
    },
    ADMIN,
    "trajetto_multa_registrada",
  ],
  [
    "service-order.created",
    {
      serviceOrderId: "018f0000-0000-7000-8000-8f2c4a9e1b3d",
      businessId: "b",
      vehicleId: "v",
      vehiclePlate: null,
      totalAmount: 0,
      currentMileage: null,
      newMileage: null,
      isCompleted: false,
      responsibleUserId: "u",
    },
    DRIVER,
    "trajetto_ordem_servico",
  ],
  [
    "service-order.updated",
    {
      serviceOrderId: "os-1",
      businessId: "b",
      vehicleId: "v",
      vehiclePlate: "RTA4F21",
      totalAmount: 10,
      responsibleUserId: "u",
    },
    ADMIN,
    "trajetto_ordem_servico",
  ],
  [
    "account-payable.created",
    {
      accountPayableId: "ap",
      businessId: "b",
      amount: 10,
      serviceOrderId: null,
      registrationUserId: "u",
    },
    ADMIN,
    "trajetto_conta_pagar",
  ],
  [
    "account-payable.updated",
    {
      accountPayableId: "ap",
      businessId: "b",
      amount: 10,
      serviceOrderId: "os",
      registrationUserId: "u",
    },
    ADMIN,
    "trajetto_conta_pagar",
  ],
  [
    "kanban-card.created",
    {
      cardId: "c",
      businessId: "b",
      title: "Card",
      description: null,
      priority: "",
      dueDate: null,
      isCompleted: false,
      assignedUserId: "u",
      fromServiceOrder: false,
    },
    ADMIN,
    "trajetto_kanban_card_criado",
  ],
  [
    "kanban-card.updated",
    {
      cardId: "c",
      businessId: "b",
      title: "Card",
      description: "linha 1\nlinha 2",
      priority: "urgent",
      dueDate: "2026-11-22T12:00:00.000Z",
      isCompleted: false,
      assignedUserId: "u",
    },
    ADMIN,
    "trajetto_kanban_card_atualizado",
  ],
  [
    "business-module.changed",
    {
      businessId: "b",
      businessName: "Empresa",
      module: "FLEET",
      enabled: true,
      previousEnabled: false,
      actor,
    },
    MASTER,
    "trajetto_modulo_plano",
  ],
  [
    "business-module.changed",
    {
      businessId: "b",
      businessName: "Empresa",
      module: "UNKNOWN",
      enabled: true,
      previousEnabled: false,
      actor,
    },
    ADMIN,
    "trajetto_modulo_habilitado_empresa",
  ],
  [
    "business-module.changed",
    {
      businessId: "b",
      businessName: "Empresa",
      module: "FLEET",
      enabled: false,
      previousEnabled: true,
      actor,
    },
    ADMIN,
    "trajetto_modulo_desabilitado_empresa",
  ],
  [
    "business-limit.changed",
    {
      businessId: "b",
      businessName: "Empresa",
      limit: "ai",
      previousValue: 0,
      newValue: 1000,
      actor,
    },
    MASTER,
    "trajetto_limite_plano",
  ],
  [
    "business-limit.changed",
    {
      businessId: "b",
      businessName: "Empresa",
      limit: "vehicle",
      previousValue: 1,
      newValue: 0,
      actor,
    },
    ADMIN,
    "trajetto_limite_plano_empresa",
  ],
  [
    "master-user.created",
    {
      masterUserId: "m",
      masterName: "Juliana",
      masterEmail: "juliana@exemplo.com.br",
      actorUserId: "u",
    },
    MASTER,
    "trajetto_master_criado",
  ],
  [
    "master-user.updated",
    {
      masterUserId: "m",
      masterName: "Juliana Souza",
      beforeName: "Juliana",
      changesNotificationText: "nome: Juliana → Juliana Souza",
      changesActivityText: "nome",
      actorUserId: "u",
      performingUserName: "Rafael",
      performingUserEmail: "rafael@exemplo.com.br",
    },
    MASTER,
    "trajetto_master_atualizado",
  ],
  [
    "master-user.account-updated",
    {
      masterUserId: "m",
      masterName: "Juliana",
      changesNotificationText: "link de redefinição de senha enviado",
      performingUserName: "Rafael",
      performingUserEmail: "rafael@exemplo.com.br",
    },
    MASTER,
    "trajetto_conta_master_atualizada",
  ],
];

describe("each internal render", () => {
  it.each(cases)(
    "%s for %o uses its template with every parameter filled",
    (topic, payload, recipient, template) => {
      const policy = notificationPolicies[topic] as unknown as {
        renderWhatsApp(
          payload: unknown,
          recipient: RecipientRenderContext,
        ): { template: string; parameters: unknown[] } | null;
      };

      const rendered = policy.renderWhatsApp(payload, recipient);

      expect(rendered?.template).toBe(template);

      const prepared = prepareInternalWhatsApp(rendered as never);

      expect(prepared.parameters).toHaveLength(
        INTERNAL_WHATSAPP_TEMPLATES[
          template as keyof typeof INTERNAL_WHATSAPP_TEMPLATES
        ].variables.length,
      );

      for (const value of prepared.parameters) {
        expect(value.trim()).not.toBe("");
      }
    },
  );

  it("covers every template of the registry", () => {
    expect(new Set(cases.map(([, , , template]) => template)).size).toBe(17);
  });

  it("never shows a master's identity to a company admin", () => {
    const topics: NotificationTopic[] = [
      "business-module.changed",
      "business-limit.changed",
      "fine.created",
    ];

    for (const [topic, payload, recipient] of cases) {
      if (!topics.includes(topic) || recipient.role === "MASTER") continue;

      const policy = notificationPolicies[topic] as unknown as {
        renderWhatsApp(p: unknown, r: RecipientRenderContext): unknown;
      };

      const text = JSON.stringify(
        policy.renderWhatsApp({ ...payload, actor }, recipient),
      );

      expect(text).not.toContain(actor.name);
      expect(text).not.toContain(actor.email);
    }
  });
});

describe("the customer's message", () => {
  const TOKEN = "ab".repeat(32);

  it.each(
    Object.keys(CUSTOMER_WHATSAPP_TEMPLATES) as Array<
      keyof typeof CUSTOMER_WHATSAPP_TEMPLATES
    >,
  )("%s fills every parameter and puts the token in both buttons", (topic) => {
    const built = buildCustomerWhatsApp(topic, {
      recipientName: null,
      carrierName: "",
      reference: null,
      deliveredAt: null,
      accessToken: TOKEN,
    });

    expect(built.name).toBe(CUSTOMER_WHATSAPP_TEMPLATES[topic].name);
    expect(built.parameters).toHaveLength(
      CUSTOMER_WHATSAPP_TEMPLATES[topic].variables.length,
    );

    for (const value of built.parameters) expect(value.trim()).not.toBe("");

    expect(built.urlButtonSuffixes).toEqual([TOKEN, TOKEN]);
  });

  it("names the load by its NF-e, then its order, then says there is none", () => {
    expect(deliveryReference([{ invoiceNumber: "123", code: "P1" }])).toBe(
      "NF-e 123",
    );
    expect(
      deliveryReference([
        { invoiceNumber: "123", code: null },
        { invoiceNumber: "124", code: null },
      ]),
    ).toBe("NF-e 123 e 124");
    expect(
      deliveryReference(
        ["1", "2", "3", "4"].map((invoiceNumber) => ({
          invoiceNumber,
          code: null,
        })),
      ),
    ).toBe("NF-e 1, 2 e mais 2");
    expect(deliveryReference([{ invoiceNumber: null, code: "P1" }])).toBe(
      "pedido P1",
    );
    expect(deliveryReference([{ invoiceNumber: " ", code: null }])).toBeNull();
  });

  it("shows the web a fixed preview with each variable named and both buttons", () => {
    const preview = customerWhatsAppPreview("DELIVERED");

    expect(preview.template).toBe("trajetto_cliente_entregue");
    expect(preview.body).toContain("[destinatário]");
    expect(preview.body).not.toMatch(/\{\{\d+\}\}/);
    expect(preview.buttons).toEqual(["Acompanhar entrega", "Parar de receber"]);
  });
});
