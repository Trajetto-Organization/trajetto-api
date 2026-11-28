import { describe, expect, it } from "vitest";

import {
  extractMetaCategoryUpdates,
  templateCategoryAlarms,
} from "@/shared/providers/whatsapp-provider/meta-webhook";

/**
 * Meta recategorizing a template (plan of 02/11/2026, item B7).
 *
 * The 21 templates exist so that nothing the product sends is Marketing:
 * Marketing is billed as such, may be blocked by the recipient's opt-out
 * of promotions and is what Meta pauses first. Meta announces a
 * recategorization on the `template_category_update` webhook — 24 hours
 * ahead (`correct_category`) and when it happens (`new_category`) — and the
 * receiver only knew `message_template_status_update`, so it passed in
 * silence. Now it is read, and one of ours leaving UTILITY is an alarm (an
 * error line, which is what the ops alerting reads).
 */
function callback(value: Record<string, unknown>, time = 1793600000) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "998877665544",
        time,
        changes: [{ field: "template_category_update", value }],
      },
    ],
  };
}

describe("reading a category update", () => {
  it("reads the template, its language and the category it moved to", () => {
    const [update] = extractMetaCategoryUpdates(
      callback({
        message_template_id: 123,
        message_template_name: "trajetto_ordem_servico",
        message_template_language: "pt_BR",
        previous_category: "UTILITY",
        new_category: "MARKETING",
      }),
    );

    expect(update).toMatchObject({
      templateName: "trajetto_ordem_servico",
      language: "pt_BR",
      previousCategory: "UTILITY",
      newCategory: "MARKETING",
      announced: false,
    });
    expect(update.occurredAt?.toISOString()).toBe(
      new Date(1793600000 * 1000).toISOString(),
    );
  });

  it("reads the notice Meta sends a day ahead as announced", () => {
    const [update] = extractMetaCategoryUpdates(
      callback({
        message_template_name: "trajetto_conta_pagar",
        message_template_language: "pt_BR",
        correct_category: "MARKETING",
      }),
    );

    expect(update).toMatchObject({
      templateName: "trajetto_conta_pagar",
      newCategory: "MARKETING",
      announced: true,
    });
  });

  it("ignores the other fields of the same callback", () => {
    expect(
      extractMetaCategoryUpdates({
        entry: [
          {
            changes: [
              {
                field: "message_template_status_update",
                value: { event: "APPROVED" },
              },
            ],
          },
        ],
      }),
    ).toEqual([]);
  });
});

describe("what is an alarm", () => {
  it("is one of ours leaving UTILITY, in pt_BR", () => {
    const alarms = templateCategoryAlarms(
      extractMetaCategoryUpdates(
        callback({
          message_template_name: "trajetto_cliente_entregue",
          message_template_language: "pt_BR",
          previous_category: "UTILITY",
          new_category: "MARKETING",
        }),
      ),
    );

    expect(alarms.map((alarm) => alarm.templateName)).toEqual([
      "trajetto_cliente_entregue",
    ]);
  });

  it("is not a template the code never sends, nor one staying UTILITY", () => {
    const alarms = templateCategoryAlarms([
      ...extractMetaCategoryUpdates(
        callback({
          message_template_name: "promocao_de_natal",
          message_template_language: "pt_BR",
          new_category: "MARKETING",
        }),
      ),
      ...extractMetaCategoryUpdates(
        callback({
          message_template_name: "trajetto_master_criado",
          message_template_language: "pt_BR",
          previous_category: "AUTHENTICATION",
          new_category: "UTILITY",
        }),
      ),
    ]);

    expect(alarms).toEqual([]);
  });
});
