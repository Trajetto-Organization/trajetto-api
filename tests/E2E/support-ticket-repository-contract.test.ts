import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { SupportTicketRepository } from "@/modules/chat/repositories/support-ticket-repository";
import { ChatRepository } from "@/modules/chat/repositories/chat-repository";
import { InMemorySupportTicketRepository } from "@/modules/chat/repositories/in-memory/in-memory-support-ticket-repository";
import { InMemoryChatRepository } from "@/modules/chat/repositories/in-memory/in-memory-chat-repository";
import type { ISupportTicketRepository } from "@/modules/chat/repositories/ISupport-ticket-repository";
import type { IChatRepository } from "@/modules/chat/repositories/IChat-repository";
import type { CreateSupportTicketProps } from "@/modules/chat/dtos/support-ticket-dto";

/**
 * The ticket repository against Postgres and its in-memory twin (decision
 * 13.2): one suite, the same fixtures. What the database decides — the
 * number per company, the partial unique indexes behind get-or-create, the
 * conditional writes, the unread cursor GREATEST(ticket, thread) — the twin
 * must decide the same way.
 */
const prisma = new PrismaClient();

const A = "018fee00-0000-7000-8000-00000000000a";
const B = "018fee00-0000-7000-8000-00000000000b";
const SHIPPER = "018fee00-0000-7000-8000-0000000000f1";
const DRIVER_A = "018fee00-0000-7000-8000-0000000000d1";
const DRIVER_B = "018fee00-0000-7000-8000-0000000000d2";
const DRIVER_USER = "018fee00-0000-7000-8000-0000000000a1";
const STAFF = "018fee00-0000-7000-8000-0000000000a2";
const OTHER_STAFF = "018fee00-0000-7000-8000-0000000000a3";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

interface Harness {
  name: string;
  tickets: ISupportTicketRepository;
  chat: IChatRepository;
  /** A delivery of company A held by DRIVER_A. */
  delivery: () => Promise<string>;
}

let cnpjSeq = 0;

async function seedBusiness(id: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Empresa ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(53444555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedDriver(id: string, businessId: string, name: string) {
  await prisma.driver.create({
    data: {
      id,
      name,
      birth_date: new Date("1990-01-01"),
      cnh: `cnh-${id.slice(-4)}`,
      cpf: `cpf-${id.slice(-4)}`,
      rg: `rg-${id.slice(-4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });
}

function databaseHarness(): Harness {
  return {
    name: "Postgres",
    tickets: new SupportTicketRepository(),
    chat: new ChatRepository(),
    delivery: async () =>
      (
        await prisma.delivery.create({
          data: {
            recipient_name: "Cliente",
            city: "São Paulo",
            uf: "SP",
            street: "Rua",
            businessId: A,
            shipperId: SHIPPER,
            driverId: DRIVER_A,
            status: "IN_TRANSIT",
          },
        })
      ).id,
  };
}

function twinHarness(): Harness {
  const chat = new InMemoryChatRepository();

  chat.driverDirectory.set(DRIVER_A, { name: "Motorista A", cnh: "1", businessId: A, status: "ACTIVE" });
  chat.driverDirectory.set(DRIVER_B, { name: "Motorista B", cnh: "2", businessId: B, status: "ACTIVE" });
  chat.userDirectory.set(DRIVER_USER, { name: "Motorista A", driverId: DRIVER_A, businessId: A });
  chat.userDirectory.set(STAFF, { name: "Torre", driverId: null, businessId: A });
  chat.userDirectory.set(OTHER_STAFF, { name: "Outra Torre", driverId: null, businessId: A });

  return {
    name: "in-memory",
    tickets: new InMemorySupportTicketRepository(chat),
    chat,
    delivery: async () => {
      const id = randomUUID();

      chat.deliveryDirectory.set(id, { recipient_name: "Cliente", status: "IN_TRANSIT" });

      return id;
    },
  };
}

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);
  await prisma.shipper.create({ data: { id: SHIPPER, name: "Embarcador", businessId: A } });
  await seedDriver(DRIVER_A, A, "Motorista A");
  await seedDriver(DRIVER_B, B, "Motorista B");

  await prisma.user.createMany({
    data: [
      { id: DRIVER_USER, name: "Motorista A", email: `${DRIVER_USER}@x.com`, password: "x", role: "BUSINESS_USER", businessId: A, driverId: DRIVER_A },
      { id: STAFF, name: "Torre", email: `${STAFF}@x.com`, password: "x", role: "BUSINESS_ADMIN", businessId: A },
      { id: OTHER_STAFF, name: "Outra Torre", email: `${OTHER_STAFF}@x.com`, password: "x", role: "BUSINESS_ADMIN", businessId: A },
    ],
  });
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const isP2002 = (error: unknown) => (error as { code?: string }).code === "P2002";

describe.each([["Postgres"], ["in-memory"]])("support ticket repository — %s", (kind) => {
  let h: Harness;
  let threadA = "";
  let threadB = "";

  const props = (overrides: Partial<CreateSupportTicketProps> = {}): CreateSupportTicketProps => ({
    businessId: A,
    threadId: threadA,
    driverId: DRIVER_A,
    kind: "DRIVER",
    subject: "Assunto",
    opened_via: "PANEL",
    ...overrides,
  });

  beforeAll(async () => {
    h = kind === "Postgres" ? databaseHarness() : twinHarness();

    // Each harness gets its own counters: wipe what the other left in Postgres.
    if (kind === "Postgres") {
      await prisma.chatMessage.deleteMany({});
      await prisma.supportTicket.deleteMany({});
      await prisma.supportTicketCounter.deleteMany({});
    }

    threadA = (await h.chat.getOrCreateThread(A, DRIVER_A)).id;
    threadB = (await h.chat.getOrCreateThread(B, DRIVER_B)).id;
  });

  it("numbers per company, from 1, and keeps companies apart", async () => {
    const first = await h.tickets.create(props());
    const second = await h.tickets.create(props());
    const foreign = await h.tickets.create(props({ businessId: B, threadId: threadB, driverId: DRIVER_B }));

    expect([first.number, second.number, foreign.number]).toEqual([1, 2, 1]);
    expect(first).toMatchObject({ status: "OPEN", version: 0, reopened_count: 0, assigneeId: null });

    // Another company's id reads as nothing.
    expect(await h.tickets.findById(first.id, B)).toBeNull();
    expect(await h.tickets.findRowById(foreign.id, A)).toBeNull();
  });

  it("allows one OPEN DELIVERY ticket per delivery, and a new one once it closed — with no hole in the numbers", async () => {
    const deliveryId = await h.delivery();
    const open = await h.tickets.create(props({ kind: "DELIVERY", deliveryId }));

    let error: unknown = null;

    try {
      await h.tickets.create(props({ kind: "DELIVERY", deliveryId }));
    } catch (caught) {
      error = caught;
    }

    expect(isP2002(error)).toBe(true);

    expect(
      await h.tickets.close({ id: open.id, businessId: A, closedById: STAFF, outcome: "RESOLVED", note: null, at: new Date() }),
    ).toBe(true);

    const next = await h.tickets.create(props({ kind: "DELIVERY", deliveryId }));

    // The failed create did not burn a number.
    expect(next.number).toBe(open.number + 1);
    expect((await h.tickets.findOpenForDelivery(deliveryId, A, "DELIVERY"))?.id).toBe(next.id);

    // Reopening the old one would make two open: refused like the insert.
    let reopenError: unknown = null;

    try {
      await h.tickets.reopen(open.id, A);
    } catch (caught) {
      reopenError = caught;
    }

    expect(isP2002(reopenError)).toBe(true);
  });

  it("keeps the idempotency key unique per company only", async () => {
    const key = randomUUID();

    await h.tickets.create(props({ client_submission_id: key }));

    let error: unknown = null;

    try {
      await h.tickets.create(props({ client_submission_id: key }));
    } catch (caught) {
      error = caught;
    }

    expect(isP2002(error)).toBe(true);

    const foreign = await h.tickets.create(
      props({ businessId: B, threadId: threadB, driverId: DRIVER_B, client_submission_id: key }),
    );

    expect(foreign.client_submission_id).toBe(key);
    expect((await h.tickets.findBySubmissionId(key, B))?.id).toBe(foreign.id);
  });

  it("writes conditionally: close once, assign against what the screen showed, first reply wins", async () => {
    const ticket = await h.tickets.create(props());
    const at = new Date();

    expect(await h.tickets.assign({ id: ticket.id, businessId: A, assigneeId: STAFF, expectedAssigneeId: null, at })).toBe(true);
    expect(
      await h.tickets.assign({ id: ticket.id, businessId: A, assigneeId: OTHER_STAFF, expectedAssigneeId: null, at }),
    ).toBe(false);
    expect(await h.tickets.autoAssign(ticket.id, OTHER_STAFF, at)).toBe(false);
    expect(await h.tickets.assign({ id: ticket.id, businessId: B, assigneeId: null, at })).toBe(false);

    const close = { id: ticket.id, businessId: A, closedById: STAFF, outcome: "RESOLVED" as const, note: "ok", at };

    expect(await h.tickets.close(close)).toBe(true);
    expect(await h.tickets.close(close)).toBe(false);
    expect(await h.tickets.assign({ id: ticket.id, businessId: A, assigneeId: null, at })).toBe(false);

    const closed = await h.tickets.findRowById(ticket.id, A);

    expect(closed).toMatchObject({
      status: "CLOSED",
      close_outcome: "RESOLVED",
      closedBy: { id: STAFF, name: "Torre" },
      assignee: { id: STAFF, name: "Torre" },
      version: 2,
    });

    expect(await h.tickets.reopen(ticket.id, A)).toBe(true);
    expect(await h.tickets.reopen(ticket.id, A)).toBe(false);
    expect(await h.tickets.findById(ticket.id, A)).toMatchObject({
      status: "OPEN",
      reopened_count: 1,
      closedById: null,
      close_outcome: null,
      version: 3,
    });

    const fresh = await h.tickets.create(props());

    expect(await h.tickets.autoAssign(fresh.id, OTHER_STAFF, at)).toBe(true);
    expect(await h.tickets.autoAssign(fresh.id, STAFF, at)).toBe(false);
  });

  it("counts unread from the GREATER of the ticket and thread cursors, and lists newest conversation first", async () => {
    const quiet = await h.tickets.create(props({ subject: "Sem mensagens" }));
    const busy = await h.tickets.create(props({ subject: "Com mensagens" }));

    const send = async (senderId: string, body: string) => {
      const message = await h.chat.createMessage({
        threadId: threadA,
        senderId,
        kind: "TEXT",
        body,
        attachment_key: null,
        duration_ms: null,
        deliveryId: null,
        broadcast_id: null,
        client_submission_id: null,
        ticketId: busy.id,
      });

      await h.tickets.touchOnMessage({
        id: busy.id,
        at: message.created_at,
        side: senderId === DRIVER_USER ? "DRIVER" : "STAFF",
      });

      await sleep(15);

      return message;
    };

    const first = await send(DRIVER_USER, "um");
    await send(DRIVER_USER, "dois");
    const reply = await send(STAFF, "resposta");

    expect((await h.tickets.unreadCounts([busy.id, quiet.id], STAFF, false)).get(busy.id)).toBe(2);
    expect((await h.tickets.unreadCounts([busy.id], DRIVER_USER, true)).get(busy.id)).toBe(1);

    // The ticket cursor covers the first message only…
    await h.tickets.markRead(busy.id, STAFF, first.created_at);

    expect((await h.tickets.unreadCounts([busy.id], STAFF, false)).get(busy.id)).toBe(1);

    // …the thread cursor (an older client) is further: the greater wins.
    await h.chat.markThreadRead(threadA, STAFF, reply.created_at);

    expect((await h.tickets.unreadCounts([busy.id], STAFF, false)).get(busy.id)).toBe(0);

    // A cursor never rewinds.
    await h.tickets.markRead(busy.id, DRIVER_USER, reply.created_at);
    await h.tickets.markRead(busy.id, DRIVER_USER, first.created_at);

    expect((await h.tickets.unreadCounts([busy.id], DRIVER_USER, true)).get(busy.id)).toBe(0);

    const last = await h.tickets.lastMessages([busy.id, quiet.id]);

    expect(last.get(busy.id)).toMatchObject({ body: "resposta", sender: { id: STAFF, name: "Torre" } });
    expect(last.has(quiet.id)).toBe(false);

    const list = await h.tickets.list({
      businessId: A,
      requesterUserId: STAFF,
      status: "OPEN",
      scope: "ALL",
      page: 1,
      pageSize: 100,
    });

    expect(list.data[0].id).toBe(busy.id);
    expect(list.data[0]).toMatchObject({
      driver: { id: DRIVER_A, name: "Motorista A" },
      driverUserId: DRIVER_USER,
    });

    const byNumber = await h.tickets.list({
      businessId: A,
      requesterUserId: STAFF,
      status: "ALL",
      scope: "ALL",
      search: `#${busy.number}`,
      page: 1,
      pageSize: 10,
    });

    expect(byNumber.data.map((row) => row.id)).toEqual([busy.id]);

    const ticket = await h.tickets.findById(busy.id, A);

    expect(ticket?.last_staff_message_at?.getTime()).toBe(reply.created_at.getTime());
    expect(ticket?.first_staff_reply_at?.getTime()).toBe(reply.created_at.getTime());

    const counts = await h.tickets.counts({ businessId: A, requesterUserId: OTHER_STAFF });

    // OTHER_STAFF never read anything: the busy ticket has unread for them.
    expect(counts.unreadOpen).toBeGreaterThanOrEqual(1);
    expect(counts.open).toBe(list.total);
  });

  it("links a DELIVERY ticket to an occurrence, and an occurrence has one ticket", async () => {
    const deliveryId = await h.delivery();
    const ticket = await h.tickets.create(props({ kind: "DELIVERY", deliveryId }));

    if (kind === "Postgres") {
      const type = await prisma.occurrenceType.create({ data: { name: `Tipo ${randomUUID().slice(0, 6)}`, businessId: A } });
      const occurrence = await prisma.deliveryOccurrence.create({
        data: { deliveryId, occurrenceTypeId: type.id, reportedById: DRIVER_USER, businessId: A } as never,
      });

      const linked = await h.tickets.linkOccurrence(ticket.id, occurrence.id);

      expect(linked).toMatchObject({ kind: "OCCURRENCE", occurrenceId: occurrence.id, version: 1 });

      let error: unknown = null;

      try {
        await h.tickets.create(props({ kind: "OCCURRENCE", deliveryId, occurrenceId: occurrence.id }));
      } catch (caught) {
        error = caught;
      }

      expect(isP2002(error)).toBe(true);
      expect((await h.tickets.findByOccurrence(occurrence.id, A))?.id).toBe(ticket.id);
      expect(await h.tickets.findByOccurrence(occurrence.id, B)).toBeNull();
    } else {
      const occurrenceId = randomUUID();
      const linked = await h.tickets.linkOccurrence(ticket.id, occurrenceId);

      expect(linked).toMatchObject({ kind: "OCCURRENCE", occurrenceId, version: 1 });

      let error: unknown = null;

      try {
        await h.tickets.create(props({ kind: "OCCURRENCE", deliveryId, occurrenceId }));
      } catch (caught) {
        error = caught;
      }

      expect(isP2002(error)).toBe(true);
      expect((await h.tickets.findByOccurrence(occurrenceId, A))?.id).toBe(ticket.id);
      expect(await h.tickets.findByOccurrence(occurrenceId, B)).toBeNull();
    }
  });
  it("answers the OTHER side's read cursor per ticket, the newest agent's for the driver", async () => {
    const one = await h.tickets.create(props({ subject: "Cursor um" }));
    const two = await h.tickets.create(props({ subject: "Cursor dois" }));

    const early = new Date("2026-10-05T10:00:00.000Z");
    const late = new Date("2026-10-05T10:05:00.000Z");

    await h.tickets.markRead(one.id, STAFF, early);
    await h.tickets.markRead(one.id, OTHER_STAFF, late);
    await h.tickets.markRead(two.id, DRIVER_USER, late);

    // The driver looking: any agent counts (the newest), his own read never.
    const forDriver = await h.tickets.counterpartReadCursors([one.id, two.id], DRIVER_USER, true);

    expect(forDriver.get(one.id)?.getTime()).toBe(late.getTime());
    expect(forDriver.has(two.id)).toBe(false);

    // The tower looking: only the driver's own cursor.
    const forStaff = await h.tickets.counterpartReadCursors([one.id, two.id], DRIVER_USER, false);

    expect(forStaff.has(one.id)).toBe(false);
    expect(forStaff.get(two.id)?.getTime()).toBe(late.getTime());

    // A driver with no account never read anything; no ids, nothing asked.
    expect((await h.tickets.counterpartReadCursors([two.id], null, false)).size).toBe(0);
    expect((await h.tickets.counterpartReadCursors([], DRIVER_USER, true)).size).toBe(0);
  });

  it("touches a ticket advance-only: an older message never moves it back", async () => {
    const ticket = await h.tickets.create(props({ subject: "Ordem" }));

    const newer = new Date("2026-10-05T11:00:00.000Z");
    const older = new Date("2026-10-05T10:00:00.000Z");

    await h.tickets.touchOnMessage({ id: ticket.id, at: newer, side: "STAFF" });
    const touched = await h.tickets.touchOnMessage({ id: ticket.id, at: older, side: "STAFF" });

    expect(touched.last_message_at?.getTime()).toBe(newer.getTime());
    expect(touched.last_staff_message_at?.getTime()).toBe(newer.getTime());
    // The response-time metric keeps the EARLIEST reply.
    expect(touched.first_staff_reply_at?.getTime()).toBe(older.getTime());
    expect(touched.version).toBe(2);

    const driver = await h.tickets.touchOnMessage({ id: ticket.id, at: older, side: "DRIVER" });

    expect(driver.last_message_at?.getTime()).toBe(newer.getTime());
    expect(driver.last_driver_message_at?.getTime()).toBe(older.getTime());
  });
});
