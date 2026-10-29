import "reflect-metadata";

import { container } from "tsyringe";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { CreateQuoteUseCase } from "@/modules/quote/usecases/create-quote/create-quote-usecase";
import { InMemoryQuoteRepository } from "@/modules/quote/repositories/in-memory/in-memory-quote-repository";

import { InMemoryMailProvider } from "@/shared/providers/mail-provider/in-memory/in-memory-mail-provider";
import { renderMailTemplate } from "@/shared/providers/mail-provider/template-renderer";

/**
 * The e-mail the public quote form sends to whatever address was typed in.
 *
 * POST /quote/create-quote needs no login, and the confirmation goes to the
 * address in the body, from the product's own sender, with the `name` and
 * `company` of the body printed in it. HTML escaping stops markup, not
 * words: "Olá, golpe-pix.example/resgate! Recebemos sua solicitação de
 * orçamento para a Seu CPF foi bloqueado…" arrives as Trajetto, and mail
 * clients turn the domain into a link. Reputation complaints on the shared
 * sender take down 2FA and password resets for every tenant with it.
 *
 * So the customer's copy says nothing the requester typed, and one address
 * gets at most one confirmation a day however many times the form is posted.
 */
const PHISHING_NAME = "golpe-pix.example/resgate Silva";
const PHISHING_COMPANY =
  "Seu CPF foi bloqueado Regularize em golpe-pix ponto example";

const SALES = "contato@intrajetto.com";

interface SentMail {
  to: string;
  subject: string;
  path: string;
  variables: Record<string, unknown>;
}

let quotes: InMemoryQuoteRepository;
let mail: InMemoryMailProvider;
let useCase: CreateQuoteUseCase;

function sent(): SentMail[] {
  return (mail as unknown as { message: SentMail[] }).message;
}

function quote(overrides: Record<string, unknown> = {}) {
  return {
    name: PHISHING_NAME,
    company: PHISHING_COMPANY,
    email: "vitima@exemplo.com.br",
    telephone: "11999999999",
    fleet_size: "1-5",
    message: null,
    ...overrides,
  };
}

/** The e-mails go out after the response; wait for this many of them. */
async function settle(count: number): Promise<void> {
  await vi.waitFor(() => expect(sent().length).toBeGreaterThanOrEqual(count));

  // One more turn, so an e-mail that should NOT have been sent has had
  // every chance to show up.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

beforeEach(() => {
  quotes = new InMemoryQuoteRepository();
  mail = new InMemoryMailProvider();

  container.registerInstance("MailProvider", mail);

  useCase = new CreateQuoteUseCase(quotes);
});

describe("the confirmation sent to the address in the form", () => {
  it("does not print the name or company the requester typed", async () => {
    await useCase.execute(quote());
    await settle(2);

    const confirmation = sent().find(
      (message) => message.to === "vitima@exemplo.com.br",
    );

    expect(confirmation).toBeDefined();

    const html = renderMailTemplate(
      confirmation!.path,
      confirmation!.variables,
    );

    expect(html).not.toContain("golpe-pix");
    expect(html).not.toContain("CPF");
    expect(confirmation!.subject).not.toContain("golpe-pix");
  });

  it("is sent once a day per address, however many times the form is posted", async () => {
    await useCase.execute(quote());
    await settle(2);

    // Same address, different case: still the same mailbox.
    await useCase.execute(quote({ email: "VITIMA@Exemplo.com.br" }));
    await settle(3);

    const confirmations = sent().filter(
      (message) => message.to.toLowerCase() === "vitima@exemplo.com.br",
    );

    expect(confirmations).toHaveLength(1);

    // The quote itself is still recorded, and sales still hears about it.
    expect(quotes.quotes).toHaveLength(2);
    expect(sent().filter((message) => message.to === SALES)).toHaveLength(2);
  });

  it("is sent again once the previous request is more than a day old", async () => {
    await useCase.execute(quote());
    await settle(2);

    quotes.quotes[0].created_at = new Date(Date.now() - 25 * 60 * 60 * 1000);

    await useCase.execute(quote());
    await settle(4);

    expect(
      sent().filter((message) => message.to === "vitima@exemplo.com.br"),
    ).toHaveLength(2);
  });
});

describe("the notification to the sales team", () => {
  it("still carries who asked, since only the team reads it", async () => {
    await useCase.execute(quote({ name: "Maria Souza", company: "Frota Boa" }));
    await settle(2);

    const toSales = sent().find((message) => message.to === SALES);

    expect(toSales?.variables).toMatchObject({
      clientName: "Maria Souza",
      company: "Frota Boa",
    });
  });
});
