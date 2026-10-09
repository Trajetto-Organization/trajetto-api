import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { container } from "tsyringe";

/**
 * The public quote form against a real Postgres (INJ-03).
 *
 * The unit test pins the rule with the in-memory repository; this one pins
 * the query that enforces it: the newest quote from this address, ignoring
 * case, inside the last day. One confirmation per mailbox per day, however
 * many times the form is posted and however the address is capitalised.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const sent: Array<{ to: string; path: string }> = [];

const QUOTE = {
  name: "Maria Souza",
  company: "Frota Boa",
  email: "dedupe@exemplo.com.br",
  telephone: "11999999999",
  fleet_size: "1-5",
};

beforeAll(async () => {
  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async (message: { to: string; path: string }) => {
      sent.push(message);
      return { messageId: "<m@x>" };
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.quote.deleteMany({
    where: { email: { equals: QUOTE.email, mode: "insensitive" } },
  });

  await app?.close();
  await prisma.$disconnect();
});

const confirmations = () =>
  sent.filter(
    (message) =>
      message.to.toLowerCase() === QUOTE.email &&
      message.path.endsWith("quote-confirmation.hbs"),
  );

async function post(email: string) {
  const response = await app.inject({
    method: "POST",
    url: "/quote/create-quote",
    payload: { ...QUOTE, email },
  });

  expect(response.statusCode, response.body).toBe(200);
}

describe("the confirmation e-mail of the public quote form", () => {
  it("goes to an address once a day, however it is capitalised", async () => {
    await post(QUOTE.email);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));

    await post("DEDUPE@Exemplo.COM.br");
    await post(QUOTE.email);

    // Both quotes are recorded, and sales hears about each of them.
    await vi.waitFor(async () =>
      expect(
        await prisma.quote.count({
          where: { email: { equals: QUOTE.email, mode: "insensitive" } },
        }),
      ).toBe(3),
    );

    await vi.waitFor(() =>
      expect(
        sent.filter((message) => message.to === "contato@intrajetto.com"),
      ).toHaveLength(3),
    );

    expect(confirmations()).toHaveLength(1);
  });

  it("goes again once the last request is more than a day old", async () => {
    await prisma.quote.updateMany({
      where: { email: { equals: QUOTE.email, mode: "insensitive" } },
      data: { created_at: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    await post(QUOTE.email);

    await vi.waitFor(() => expect(confirmations()).toHaveLength(2));
  });
});
