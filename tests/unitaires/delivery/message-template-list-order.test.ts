import { describe, expect, it } from "vitest";

import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";

/**
 * The in-memory twin lists a company's templates in the order Prisma does
 * (decision 13.2): `orderBy [topic asc, channel asc]` on Postgres enums sorts
 * by DECLARATION order (DISPATCHED, DELIVERED, FAILED, ON_THE_WAY; IN_APP,
 * EMAIL, WHATSAPP, ...), not alphabetically and not by insertion.
 */
describe("the in-memory message templates list", () => {
  it("sorts like Postgres: topic, then channel, by enum declaration order", async () => {
    const repository = new InMemoryDeliveryMessageTemplateRepository();

    const save = (
      topic: "DISPATCHED" | "DELIVERED" | "FAILED" | "ON_THE_WAY",
      channel: string,
    ) =>
      repository.save({
        businessId: "b1",
        topic,
        channel,
        subject: null,
        body: `${topic} ${channel}`,
        is_active: true,
      });

    await save("ON_THE_WAY", "WHATSAPP");
    await save("FAILED", "EMAIL");
    await save("DISPATCHED", "WHATSAPP");
    await save("ON_THE_WAY", "EMAIL");
    await save("DELIVERED", "EMAIL");
    await save("DISPATCHED", "EMAIL");

    await repository.save({
      businessId: "other",
      topic: "DISPATCHED",
      channel: "EMAIL",
      subject: null,
      body: "outra empresa",
      is_active: true,
    });

    const listed = await repository.listByBusiness("b1");

    expect(listed.map((entry) => `${entry.topic}:${entry.channel}`)).toEqual([
      "DISPATCHED:EMAIL",
      "DISPATCHED:WHATSAPP",
      "DELIVERED:EMAIL",
      "FAILED:EMAIL",
      "ON_THE_WAY:EMAIL",
      "ON_THE_WAY:WHATSAPP",
    ]);
  });
});
