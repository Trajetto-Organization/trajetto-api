import { describe, expect, it } from "vitest";

import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";
import {
  messageOptOutOf,
  normalizeSuppressionEmail,
  suppressionAddresses,
} from "@/shared/notifications/customer-message-suppression";
import { normalizePhoneNumber } from "@/shared/providers/whatsapp-provider/phone-number";

/**
 * The opt-out by phone and e-mail inside the carrier (plan of 02/11/2026,
 * B5, decision D38). "Parar de receber" used to stop only the delivery whose
 * link was clicked: somebody who receives many deliveries from the same
 * carrier kept getting the next one's messages. Now the click also records
 * the recipient's phone and e-mail, normalized, for that carrier only.
 */

const CARRIER = "018f7000-0000-7000-8000-0000000000a1";
const OTHER = "018f7000-0000-7000-8000-0000000000a2";

describe("the addresses a suppression is kept under", () => {
  it("normalizes the phone with the WhatsApp sender's own rule", () => {
    // The same number typed three ways is one address: what Meta receives.
    for (const typed of [
      "(11) 99123-4567",
      "11991234567",
      "+55 11 99123-4567",
    ]) {
      expect(suppressionAddresses({ telephone: typed, email: null })).toEqual([
        { channel: "WHATSAPP", address: normalizePhoneNumber(typed) },
      ]);
    }

    expect(normalizePhoneNumber("(11) 99123-4567")).toBe("5511991234567");
  });

  it("reads a mobile typed without the ninth digit, or behind a dialling prefix, as the same line", () => {
    // Old customer records still carry the 8-digit mobile of before the ninth
    // digit, and some ERPs write the trunk "0" or the international "00" in
    // front. Each is the person who opted out as "(11) 99123-4567".
    for (const typed of [
      "(11) 9123-4567",
      "1191234567",
      "551191234567",
      "+55 11 9123-4567",
      "011 99123-4567",
      "0 11 9123-4567",
      "0055 11 99123-4567",
    ]) {
      expect(suppressionAddresses({ telephone: typed, email: null })).toEqual([
        { channel: "WHATSAPP", address: "5511991234567" },
      ]);
    }
  });

  it("keys every nine-digit line exactly where the WhatsApp sender delivers it", () => {
    // The opt-out key and Meta's `to` share the prefix handling: a number
    // behind a dialling prefix is suppressed under the line the message
    // would actually reach, not under a destination that does not exist.
    for (const typed of [
      "011 99123-4567",
      "0055 11 99123-4567",
      "0 11 3123-4567",
      "(11) 99123-4567",
    ]) {
      expect(suppressionAddresses({ telephone: typed, email: null })).toEqual([
        { channel: "WHATSAPP", address: normalizePhoneNumber(typed) },
      ]);
    }
  });

  it("never turns a landline, or a number without area code, into a mobile", () => {
    // Landlines start with 2-5: "(11) 3333-4444" is not "(11) 93333-4444".
    expect(
      suppressionAddresses({ telephone: "(11) 3333-4444", email: null }),
    ).toEqual([{ channel: "WHATSAPP", address: "551133334444" }]);
    // Area code 55 (Santa Maria/RS): decided by length, never by prefix.
    expect(
      suppressionAddresses({ telephone: "(55) 9123-4567", email: null }),
    ).toEqual([{ channel: "WHATSAPP", address: "5555991234567" }]);
    expect(
      suppressionAddresses({ telephone: "99123-4567", email: null }),
    ).toEqual([{ channel: "WHATSAPP", address: "991234567" }]);
  });

  it("lower-cases and trims the e-mail", () => {
    expect(normalizeSuppressionEmail("  Maria.Souza@Exemplo.COM.br ")).toBe(
      "maria.souza@exemplo.com.br",
    );
    expect(
      suppressionAddresses({ telephone: null, email: " Maria@Exemplo.com " }),
    ).toEqual([{ channel: "EMAIL", address: "maria@exemplo.com" }]);
  });

  it("keeps nothing for a contact without digits or text", () => {
    expect(suppressionAddresses({ telephone: "  ", email: "   " })).toEqual([]);
    expect(suppressionAddresses({ telephone: null, email: null })).toEqual([]);
  });

  it("keeps an e-mail list under each address and under the whole field", () => {
    // The whole field is the key the first release of D38 wrote and looks
    // up; each address is what the send writes to (recipient-email.ts).
    expect(
      suppressionAddresses({
        telephone: null,
        email: "Compras@Mercado.com.br; financeiro@mercado.com.br;lixo",
      }),
    ).toEqual([
      {
        channel: "EMAIL",
        address: "compras@mercado.com.br; financeiro@mercado.com.br;lixo",
      },
      { channel: "EMAIL", address: "compras@mercado.com.br" },
      { channel: "EMAIL", address: "financeiro@mercado.com.br" },
    ]);
  });
});

describe("an opt-out from an e-mail list (the NF-e's and the spreadsheet's)", () => {
  const LIST = "compras@mercado.com.br; financeiro@mercado.com.br";

  async function optedOutFrom(email: string) {
    const recipients = new InMemoryExternalRecipientRepository();
    const recipient = await recipients.ensureForDelivery({
      deliveryId: "delivery-a",
      businessId: CARRIER,
      name: "Mercado",
      email,
      telephone: null,
    });

    await recipients.optOut(recipient.access_token);

    return recipients;
  }

  const emailOf = async (
    recipients: InMemoryExternalRecipientRepository,
    email: string,
  ) => recipients.suppressedChannels(CARRIER, { telephone: null, email });

  it("stops the same list as the import now stores it, each address alone, and a list sharing one", async () => {
    // Before this release an import stored the field as written ("a; b");
    // now as "a;b". The click was on a delivery written before.
    const recipients = await optedOutFrom(LIST);

    for (const email of [
      "compras@mercado.com.br;financeiro@mercado.com.br",
      "financeiro@mercado.com.br",
      // The e-mail goes to both, so it is not sent to either.
      "Financeiro@Mercado.com.br;outro@mercado.com.br",
    ]) {
      expect(await emailOf(recipients, email), email).toEqual(
        new Set(["EMAIL"]),
      );
    }

    expect(await emailOf(recipients, "outro@mercado.com.br")).toEqual(
      new Set(),
    );

    expect(recipients.suppressions.map((row) => row.address)).toEqual([
      LIST,
      "compras@mercado.com.br",
      "financeiro@mercado.com.br",
    ]);
  });

  it("stops a delivery written before this release, still on its way, from a click on a new one", async () => {
    const recipients = await optedOutFrom(
      "compras@mercado.com.br;financeiro@mercado.com.br",
    );

    // The old delivery's recipient row holds the field as it was typed.
    expect(await emailOf(recipients, ` ${LIST} ;`)).toEqual(new Set(["EMAIL"]));
  });

  it("keeps matching a row the first release wrote, under the whole field", async () => {
    const recipients = new InMemoryExternalRecipientRepository();

    recipients.suppressions.push({
      businessId: CARRIER,
      channel: "EMAIL",
      address: "compras@mercado.com.br;financeiro@mercado.com.br",
      source_delivery_id: "delivery-old",
      created_at: new Date("2026-11-04T12:00:00.000Z"),
    });

    expect(
      await emailOf(
        recipients,
        "compras@mercado.com.br;financeiro@mercado.com.br",
      ),
    ).toEqual(new Set(["EMAIL"]));
  });

  it("answers the detail with the earliest of the opt-outs its list matches", () => {
    const earlier = new Date("2026-11-04T12:00:00.000Z");
    const later = new Date("2026-11-06T12:00:00.000Z");

    expect(
      messageOptOutOf(
        { telephone: null, email: "compras@mercado.com.br;b@y.com.br" },
        [
          { channel: "EMAIL", address: "b@y.com.br", created_at: later },
          {
            channel: "EMAIL",
            address: "compras@mercado.com.br",
            created_at: earlier,
          },
          // Another address of the company: not this contact's.
          { channel: "EMAIL", address: "z@z.com.br", created_at: new Date(0) },
        ],
        null,
      ),
    ).toEqual({ whatsapp: null, email: earlier });
  });
});

describe("the twin's opt-out (same semantics as the Prisma repository)", () => {
  function seed() {
    const recipients = new InMemoryExternalRecipientRepository();

    return recipients;
  }

  async function recipientOf(
    recipients: InMemoryExternalRecipientRepository,
    deliveryId: string,
    businessId: string,
    contact: { telephone: string | null; email: string | null },
  ) {
    return recipients.ensureForDelivery({
      deliveryId,
      businessId,
      name: "Maria Souza",
      ...contact,
    });
  }

  it("suppresses the phone and the e-mail for every delivery of the same carrier", async () => {
    const recipients = seed();
    const first = await recipientOf(recipients, "delivery-a", CARRIER, {
      telephone: "(11) 99123-4567",
      email: "Maria@Exemplo.com.br",
    });

    expect(await recipients.optOut(first.access_token)).toBe(true);

    // Delivery B of the same carrier, the contact typed differently.
    expect(
      await recipients.suppressedChannels(CARRIER, {
        telephone: "11991234567",
        email: " maria@exemplo.com.br",
      }),
    ).toEqual(new Set(["WHATSAPP", "EMAIL"]));

    // Another carrier still writes to the same person.
    expect(
      await recipients.suppressedChannels(OTHER, {
        telephone: "11991234567",
        email: "maria@exemplo.com.br",
      }),
    ).toEqual(new Set());
  });

  it("is idempotent: a second click keeps one suppression per address", async () => {
    const recipients = seed();
    const first = await recipientOf(recipients, "delivery-a", CARRIER, {
      telephone: "11991234567",
      email: "maria@exemplo.com.br",
    });

    await recipients.optOut(first.access_token);
    await recipients.optOut(first.access_token);

    expect(recipients.suppressions).toHaveLength(2);
    expect(recipients.suppressions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          businessId: CARRIER,
          channel: "WHATSAPP",
          address: "5511991234567",
          source_delivery_id: "delivery-a",
        }),
        expect.objectContaining({
          businessId: CARRIER,
          channel: "EMAIL",
          address: "maria@exemplo.com.br",
          source_delivery_id: "delivery-a",
        }),
      ]),
    );
  });

  it("records nothing for a token nobody holds", async () => {
    const recipients = seed();

    expect(await recipients.optOut("f".repeat(64))).toBe(false);
    expect(recipients.suppressions).toEqual([]);
  });

  it("suppresses the next delivery whose mobile was typed without the ninth digit", async () => {
    const recipients = seed();
    const first = await recipientOf(recipients, "delivery-a", CARRIER, {
      telephone: "11991234567",
      email: null,
    });

    await recipients.optOut(first.access_token);

    expect(
      await recipients.suppressedChannels(CARRIER, {
        telephone: "1191234567",
        email: null,
      }),
    ).toEqual(new Set(["WHATSAPP"]));
  });

  it("keeps a suppression to the channel the contact has", async () => {
    const recipients = seed();
    const first = await recipientOf(recipients, "delivery-a", CARRIER, {
      telephone: "11991234567",
      email: null,
    });

    await recipients.optOut(first.access_token);

    expect(
      await recipients.suppressedChannels(CARRIER, {
        telephone: "11991234567",
        email: "maria@exemplo.com.br",
      }),
    ).toEqual(new Set(["WHATSAPP"]));
  });
});
