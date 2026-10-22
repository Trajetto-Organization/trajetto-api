import { describe, expect, it } from "vitest";

import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";

/**
 * The twin lists recipients in the order Postgres does.
 *
 * Every environment runs postgres:16-alpine, whose musl libc collates
 * en_US.utf8 by code point: ORDER BY name puts ANA < Ana < ana < bia < zeca
 * < Ágata < Élio (measured; tests/E2E/driver-repository-contract pins it for
 * drivers). The twin sorted with localeCompare("en-US"), which puts Ágata
 * next to ana and Élio before zeca, so a unit test passed on an order the
 * database never returns.
 */
const BUSINESS = "018fe7f0-0000-7000-8000-00000000000a";

describe("the chat twin's recipient order", () => {
  it("is Postgres' code-point order, ties broken by id", async () => {
    const chat = new InMemoryChatRepository();
    const names = ["zeca", "Élio", "ana", "Ágata", "bia", "Ana", "ANA"];

    names.forEach((name, index) => {
      chat.driverDirectory.set(
        `018fe7f0-0000-7000-8000-0000000000${10 + index}`,
        {
          name,
          cnh: `cnh-${index}`,
          businessId: BUSINESS,
          status: "ACTIVE",
        },
      );
    });

    const page = await chat.listRecipients({
      businessId: BUSINESS,
      app: "ALL",
      limit: 50,
    } as never);

    expect(page.data.map((row) => row.name)).toEqual([
      "ANA",
      "Ana",
      "ana",
      "bia",
      "zeca",
      "Ágata",
      "Élio",
    ]);
  });
});
