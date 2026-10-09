import { describe, expect, it, vi } from "vitest";

import { DeleteQuoteUseCase } from "@/modules/quote/usecases/delete-quote/delete-quote-usecase";

import { InMemoryQuoteRepository } from "@/modules/quote/repositories/in-memory/in-memory-quote-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * Quotes are the platform's sales leads: only the MASTER deletes one. A
 * company user is refused with the standard PERMISSION_DENIED (decision 4.1)
 * before the quote is even looked up, so the answer does not reveal which
 * ids exist.
 */
const MASTER = "018f0000-0000-7000-8000-0000000000f1";
const ADMIN = "018f0000-0000-7000-8000-0000000000a1";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";

async function makeContext() {
  const users = new InMemoryUserRepository();
  const quotes = new InMemoryQuoteRepository();

  users.user.push(
    { id: MASTER, role: "MASTER", businessId: null } as User,
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: "018f0000-0000-7000-8000-00000000000a" } as User,
  );

  const quote = await quotes.createQuote({
    name: "Carla",
    company: "Transportes Beta",
    email: "carla@beta.com.br",
    telephone: "11999990000",
    fleet_size: "10-50",
    message: "Quero uma demonstração",
  } as never);

  return { quotes, quote, remove: new DeleteQuoteUseCase(users, quotes) };
}

describe("deleting a quote", () => {
  it("lets the MASTER delete it", async () => {
    const { quotes, quote, remove } = await makeContext();

    const deleted = await remove.execute(quote.id, MASTER);

    expect(deleted.id).toBe(quote.id);
    expect(quotes.quotes).toHaveLength(0);
  });

  it("refuses a company user with PERMISSION_DENIED, the same for an existing or missing id", async () => {
    const { quotes, quote, remove } = await makeContext();

    const existing = await remove.execute(quote.id, ADMIN).catch((error) => error);
    const missing = await remove.execute(GHOST, ADMIN).catch((error) => error);

    expect(existing).toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    expect(missing).toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    expect(quotes.quotes).toHaveLength(1);
  });

  it("answers a missing quote with 404 and an unknown user with 404", async () => {
    const { remove, quote } = await makeContext();

    await expect(remove.execute(GHOST, MASTER)).rejects.toMatchObject({ statusCode: 404, code: "QUOTE_NOT_FOUND" });
    await expect(remove.execute(quote.id, GHOST)).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });

  it("turns a repository failure into a 500 and keeps the quote", async () => {
    const { quotes, quote, remove } = await makeContext();
    vi.spyOn(quotes, "deleteQuote").mockRejectedValueOnce(new Error("down"));

    await expect(remove.execute(quote.id, MASTER)).rejects.toMatchObject({ statusCode: 500 });
    expect(quotes.quotes).toHaveLength(1);
  });
});
