import { describe, expect, it } from "vitest";

import type { IChatRepository } from "@/modules/chat/repositories/IChat-repository";
import type { ChatMessage } from "@/modules/chat/dtos/chat-dto";

import { expectPrismaCode, fixedId, minute, type Kind } from "../support";

/**
 * The chat repository's contract (decision 13.2): threads per company and
 * driver, the SAC list (order, search, unread), the history cursor (before,
 * after, around), the message search, the idempotency key scoped to the
 * company, the recipient pickers (who is active, who can use the app, the
 * code-point order and the cursor), the route lookups and the advance-only
 * cursors.
 */

const at = (offset: number) => minute(offset);

const CHAT_FIXTURE = {
  A: fixedId("c4a0", 1),
  B: fixedId("c4a0", 2),
  branchOff: fixedId("c4ab", 1),

  // Drivers of A: two with the app, one without an account, one revoked,
  // one in an inactive branch, one inactive. A lowercase name sorts after
  // every uppercase one in code-point order.
  dAna: fixedId("c4ad", 1),
  dBruno: fixedId("c4ad", 2),
  dCarla: fixedId("c4ad", 3),
  dDiego: fixedId("c4ad", 4),
  dEva: fixedId("c4ad", 5),
  dZeca: fixedId("c4ad", 6),
  dB: fixedId("c4ad", 9),

  uAna: fixedId("c4a1", 1),
  uCarla: fixedId("c4a1", 3),
  uDiego: fixedId("c4a1", 4),
  uEva: fixedId("c4a1", 5),
  uZeca: fixedId("c4a1", 6),
  uB: fixedId("c4a1", 9),
  staffA: fixedId("c4a2", 1),
  staffA2: fixedId("c4a2", 2),
  staffB: fixedId("c4a2", 9),

  // tBruno and tZeca tie on created_at with no message: the id breaks it.
  tAna: fixedId("c4a3", 1),
  tBruno: fixedId("c4a3", 2),
  tZeca: fixedId("c4a3", 3),
  tB: fixedId("c4a3", 9),

  // m2 and m3 share an instant; m3 has the bigger id.
  m1: fixedId("c4a4", 1),
  m2: fixedId("c4a4", 2),
  m3: fixedId("c4a4", 3),
  m4: fixedId("c4a4", 4),
  mB: fixedId("c4a4", 9),

  shipperA: fixedId("c4a5", 1),
  dl1: fixedId("c4ae", 1),

  rDone: fixedId("c4a6", 1),
  rRun: fixedId("c4a6", 2),
  rZecaOld: fixedId("c4a6", 3),
  rZecaNull: fixedId("c4a6", 4),
  rB: fixedId("c4a6", 9),
  rMissing: fixedId("c4a6", 99),
  threadMissing: fixedId("c4a3", 99),
} as const;

const F = CHAT_FIXTURE;

const DRIVERS = [
  {
    id: F.dAna,
    businessId: F.A,
    name: "Ana Souza",
    status: "ACTIVE",
    branchOff: false,
  },
  {
    id: F.dBruno,
    businessId: F.A,
    name: "bruno lima",
    status: "ACTIVE",
    branchOff: false,
  },
  {
    id: F.dCarla,
    businessId: F.A,
    name: "Carla",
    status: "INACTIVE",
    branchOff: false,
  },
  {
    id: F.dDiego,
    businessId: F.A,
    name: "Diego",
    status: "ACTIVE",
    branchOff: false,
  },
  {
    id: F.dEva,
    businessId: F.A,
    name: "Eva",
    status: "ACTIVE",
    branchOff: true,
  },
  {
    id: F.dZeca,
    businessId: F.A,
    name: "Zeca",
    status: "ACTIVE",
    branchOff: false,
  },
  {
    id: F.dB,
    businessId: F.B,
    name: "Ana Beatriz",
    status: "ACTIVE",
    branchOff: false,
  },
] as const;

const USERS = [
  {
    id: F.uAna,
    businessId: F.A,
    name: "Ana (app)",
    driverId: F.dAna,
    revoked: false,
  },
  {
    id: F.uCarla,
    businessId: F.A,
    name: "Carla (app)",
    driverId: F.dCarla,
    revoked: false,
  },
  {
    id: F.uDiego,
    businessId: F.A,
    name: "Diego (app)",
    driverId: F.dDiego,
    revoked: true,
  },
  {
    id: F.uEva,
    businessId: F.A,
    name: "Eva (app)",
    driverId: F.dEva,
    revoked: false,
  },
  {
    id: F.uZeca,
    businessId: F.A,
    name: "Zeca (app)",
    driverId: F.dZeca,
    revoked: false,
  },
  {
    id: F.uB,
    businessId: F.B,
    name: "Beatriz (app)",
    driverId: F.dB,
    revoked: false,
  },
  {
    id: F.staffA,
    businessId: F.A,
    name: "Atendente A",
    driverId: null,
    revoked: false,
  },
  {
    id: F.staffA2,
    businessId: F.A,
    name: "Atendente A2",
    driverId: null,
    revoked: false,
  },
  {
    id: F.staffB,
    businessId: F.B,
    name: "Atendente B",
    driverId: null,
    revoked: false,
  },
] as const;

const THREADS = [
  {
    id: F.tAna,
    businessId: F.A,
    driverId: F.dAna,
    created_at: at(0),
    last_message_at: at(30),
  },
  {
    id: F.tBruno,
    businessId: F.A,
    driverId: F.dBruno,
    created_at: at(1),
    last_message_at: null,
  },
  {
    id: F.tZeca,
    businessId: F.A,
    driverId: F.dZeca,
    created_at: at(1),
    last_message_at: null,
  },
  {
    id: F.tB,
    businessId: F.B,
    driverId: F.dB,
    created_at: at(0),
    last_message_at: at(40),
  },
] as const;

const MESSAGES: Array<
  Pick<
    ChatMessage,
    | "id"
    | "threadId"
    | "senderId"
    | "body"
    | "created_at"
    | "client_submission_id"
  >
> = [
  {
    id: F.m1,
    threadId: F.tAna,
    senderId: F.uAna,
    body: "Olá, cheguei no cliente",
    created_at: at(10),
    client_submission_id: null,
  },
  {
    id: F.m2,
    threadId: F.tAna,
    senderId: F.staffA,
    body: "Pode descarregar 50% agora",
    created_at: at(20),
    client_submission_id: null,
  },
  {
    id: F.m3,
    threadId: F.tAna,
    senderId: F.uAna,
    body: "ok",
    created_at: at(20),
    client_submission_id: null,
  },
  {
    id: F.m4,
    threadId: F.tAna,
    senderId: F.uAna,
    body: "Problema na NOTA",
    created_at: at(30),
    client_submission_id: "chat-contract-a-1",
  },
  {
    id: F.mB,
    threadId: F.tB,
    senderId: F.uB,
    body: "Olá, cheguei na base",
    created_at: at(40),
    client_submission_id: "chat-contract-b-1",
  },
];

/** The staff of A read tAna up to m2/m3's instant. */
const READS = [
  { threadId: F.tAna, userId: F.staffA, last_read_at: at(20) },
] as const;

const ROUTES = [
  {
    id: F.rDone,
    businessId: F.A,
    driverId: F.dAna,
    code: 1,
    name: "Rota encerrada",
    status: "COMPLETED",
    started_at: at(1),
    created_at: at(1),
  },
  {
    id: F.rRun,
    businessId: F.A,
    driverId: F.dAna,
    code: 2,
    name: "Rota em curso",
    status: "IN_PROGRESS",
    started_at: at(5),
    created_at: at(2),
  },
  {
    id: F.rZecaOld,
    businessId: F.A,
    driverId: F.dZeca,
    code: 3,
    name: null,
    status: "IN_PROGRESS",
    started_at: at(3),
    created_at: at(3),
  },
  {
    id: F.rZecaNull,
    businessId: F.A,
    driverId: F.dZeca,
    code: 4,
    name: null,
    status: "IN_PROGRESS",
    started_at: null,
    created_at: at(4),
  },
  {
    id: F.rB,
    businessId: F.B,
    driverId: F.dB,
    code: 1,
    name: "Rota B",
    status: "IN_PROGRESS",
    started_at: at(6),
    created_at: at(6),
  },
] as const;

/** dl1 rode the completed route last, but the running one still carries it. */
const STOPS = [
  {
    id: fixedId("c4a7", 1),
    routeId: F.rRun,
    deliveryId: F.dl1,
    sequence: 1,
    status: "PENDING",
    created_at: at(2),
  },
  {
    id: fixedId("c4a7", 2),
    routeId: F.rDone,
    deliveryId: F.dl1,
    sequence: 1,
    status: "COMPLETED",
    created_at: at(9),
  },
] as const;

interface ChatHarness {
  kind: Kind;
  repo: IChatRepository;
}

function chatRepositoryContract(harness: () => ChatHarness): void {
  const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id);

  describe("threads", () => {
    it("finds a driver's thread only inside the company", async () => {
      const { repo } = harness();

      expect((await repo.findThreadByDriver(F.A, F.dAna))?.id).toBe(F.tAna);
      expect(await repo.findThreadByDriver(F.B, F.dAna)).toBeNull();
      expect((await repo.findThreadById(F.tB))?.businessId).toBe(F.B);
      expect(await repo.findThreadById(F.threadMissing)).toBeNull();
    });

    it("lists one company, freshest first, never-written threads by creation and then id", async () => {
      const { repo } = harness();

      const result = await repo.listThreads({
        businessId: F.A,
        requesterUserId: F.staffA,
        page: 1,
        pageSize: 10,
      });

      expect(ids(result.data)).toEqual([F.tAna, F.tZeca, F.tBruno]);
      expect(result.total).toBe(3);

      const second = await repo.listThreads({
        businessId: F.A,
        requesterUserId: F.staffA,
        page: 2,
        pageSize: 2,
      });

      expect(ids(second.data)).toEqual([F.tBruno]);
      expect(second.total).toBe(3);
    });

    it("previews the newest message and the driver's app account", async () => {
      const { repo } = harness();

      const { data } = await repo.listThreads({
        businessId: F.A,
        requesterUserId: F.staffA,
        page: 1,
        pageSize: 10,
      });

      const ana = data.find((row) => row.id === F.tAna)!;

      expect(ana.driver).toMatchObject({ id: F.dAna, name: "Ana Souza" });
      expect(ana.driverUser).toEqual({ id: F.uAna, last_seen_at: null });
      expect(ana.lastMessage).toEqual({
        kind: "TEXT",
        body: "Problema na NOTA",
        sender: { id: F.uAna, name: "Ana (app)" },
        created_at: at(30),
      });

      const bruno = data.find((row) => row.id === F.tBruno)!;

      expect(bruno.driverUser).toBeNull();
      expect(bruno.lastMessage).toBeNull();
    });

    it("counts as unread only the other side's messages after the reader's cursor", async () => {
      const { repo } = harness();

      // The agent read up to m2/m3: only m4 (the driver's, later) is unread.
      const staff = await repo.listThreads({
        businessId: F.A,
        requesterUserId: F.staffA,
        page: 1,
        pageSize: 10,
      });

      expect(staff.data.find((row) => row.id === F.tAna)!.unreadCount).toBe(1);
      expect(staff.totalUnread).toBe(1);

      // Another agent has no cursor: every driver message is unread.
      const other = await repo.listThreads({
        businessId: F.A,
        requesterUserId: F.staffA2,
        page: 1,
        pageSize: 10,
      });

      expect(other.totalUnread).toBe(3);

      // The driver never read: the agent's single message is unread.
      const driver = await repo.listThreads({
        businessId: F.A,
        requesterUserId: F.uAna,
        driverId: F.dAna,
        page: 1,
        pageSize: 10,
      });

      expect(ids(driver.data)).toEqual([F.tAna]);
      expect(driver.data[0].unreadCount).toBe(1);
      expect(driver.totalUnread).toBe(1);
    });

    it("searches the driver's name case-insensitively and literally", async () => {
      const { repo } = harness();
      const search = async (term: string) =>
        ids(
          (
            await repo.listThreads({
              businessId: F.A,
              requesterUserId: F.staffA,
              search: term,
              page: 1,
              pageSize: 10,
            })
          ).data,
        );

      expect(await search("  SOUZA ")).toEqual([F.tAna]);
      expect(await search("BRUNO")).toEqual([F.tBruno]);
      expect(await search("%")).toEqual([]);
      // "Ana Beatriz" is another company's driver.
      expect(await search("beatriz")).toEqual([]);
    });
  });

  describe("history", () => {
    const page = (
      repo: IChatRepository,
      extra: Partial<Parameters<IChatRepository["listMessages"]>[0]> = {},
    ) =>
      repo.listMessages({
        threadId: F.tAna,
        viewerIsDriverSide: false,
        limit: 2,
        ...extra,
      });

    it("pages backwards newest first, the id breaking a tie", async () => {
      const { repo } = harness();

      const first = await page(repo);

      expect(ids(first.data)).toEqual([F.m4, F.m3]);
      expect(first.nextCursor).toEqual({
        created_at: at(20).toISOString(),
        id: F.m3,
      });
      expect(first.previousCursor).toBeNull();
      expect(first.hasNewer).toBe(false);

      const second = await page(repo, {
        before: { created_at: at(20), id: F.m3 },
      });

      expect(ids(second.data)).toEqual([F.m2, F.m1]);
      expect(second.nextCursor).toBeNull();
    });

    it("walks forward from a message and centres on one", async () => {
      const { repo } = harness();

      const forward = await page(repo, {
        after: { created_at: at(10), id: F.m1 },
      });

      expect(ids(forward.data)).toEqual([F.m3, F.m2]);
      expect(forward.hasNewer).toBe(true);
      expect(forward.nextCursor).toBeNull();
      expect(forward.previousCursor).toEqual({
        created_at: at(20).toISOString(),
        id: F.m3,
      });

      const around = await page(repo, {
        around: { created_at: at(20), id: F.m2 },
        limit: 3,
      });

      expect(ids(around.data)).toEqual([F.m3, F.m2, F.m1]);
      expect(around.hasNewer).toBe(true);
      expect(around.nextCursor).toBeNull();
    });

    it("filters by text case-insensitively and literally, and resolves the sender", async () => {
      const { repo } = harness();

      expect(
        ids((await page(repo, { search: "nota", limit: 10 })).data),
      ).toEqual([F.m4]);
      expect(
        ids((await page(repo, { search: "50%", limit: 10 })).data),
      ).toEqual([F.m2]);
      expect(ids((await page(repo, { search: "_", limit: 10 })).data)).toEqual(
        [],
      );

      const [view] = (await page(repo, { search: "50%" })).data;

      expect(view.sender).toEqual({ id: F.staffA, name: "Atendente A" });
      expect(view.delivery).toBeNull();
      expect(view.route).toBeNull();
    });

    it("shows each side the other side's read cursor", async () => {
      const { repo } = harness();

      expect(
        (await page(repo, { viewerIsDriverSide: true })).counterpartLastReadAt,
      ).toEqual(at(20));
      expect((await page(repo)).counterpartLastReadAt).toBeNull();
    });
  });

  describe("search across conversations", () => {
    it("finds the company's messages only, newest first, with the driver", async () => {
      const { repo } = harness();

      const hits = await repo.searchMessages({
        businessId: F.A,
        search: "CHEGUEI",
        limit: 10,
      });

      expect(ids(hits)).toEqual([F.m1]);
      expect(hits[0].driver).toEqual({ id: F.dAna, name: "Ana Souza" });

      expect(
        ids(
          await repo.searchMessages({
            businessId: F.B,
            search: "cheguei",
            limit: 10,
          }),
        ),
      ).toEqual([F.mB]);
      expect(
        ids(
          await repo.searchMessages({ businessId: F.A, search: "o", limit: 2 }),
        ),
      ).toEqual([F.m4, F.m3]);
      expect(
        await repo.searchMessages({
          businessId: F.A,
          search: "   ",
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        await repo.searchMessages({
          businessId: F.A,
          search: "cheguei",
          driverId: F.dZeca,
          limit: 10,
        }),
      ).toEqual([]);
    });

    it("answers an idempotency key only inside its company", async () => {
      const { repo } = harness();

      expect(
        (await repo.findMessageBySubmissionId("chat-contract-b-1", F.B))?.id,
      ).toBe(F.mB);
      expect(
        await repo.findMessageBySubmissionId("chat-contract-b-1", F.A),
      ).toBeNull();
      expect(
        await repo.findMessageBySubmissionId("never-sent", F.A),
      ).toBeNull();
    });
  });

  describe("recipients", () => {
    it("offers active drivers in code-point order, saying who can use the app", async () => {
      const { repo } = harness();

      const all = await repo.listRecipients({ businessId: F.A, limit: 10 });

      expect(all.data).toEqual([
        { id: F.dAna, name: "Ana Souza", hasApp: true },
        { id: F.dDiego, name: "Diego", hasApp: false },
        { id: F.dEva, name: "Eva", hasApp: false },
        { id: F.dZeca, name: "Zeca", hasApp: true },
        { id: F.dBruno, name: "bruno lima", hasApp: false },
      ]);
      expect(all.hasMore).toBe(false);

      expect(
        ids(
          (
            await repo.listRecipients({
              businessId: F.A,
              app: "WITH_APP",
              limit: 10,
            })
          ).data,
        ),
      ).toEqual([F.dAna, F.dZeca]);
      expect(
        ids(
          (
            await repo.listRecipients({
              businessId: F.A,
              app: "WITHOUT_APP",
              limit: 10,
            })
          ).data,
        ),
      ).toEqual([F.dDiego, F.dEva, F.dBruno]);
      expect(
        ids(
          (
            await repo.listRecipients({
              businessId: F.A,
              search: "ANA",
              limit: 10,
            })
          ).data,
        ),
      ).toEqual([F.dAna]);
      expect(
        (await repo.listRecipients({ businessId: F.B, limit: 10 })).data,
      ).toEqual([{ id: F.dB, name: "Ana Beatriz", hasApp: true }]);
    });

    it("walks the cursor without repeating or skipping", async () => {
      const { repo } = harness();
      const seen: string[] = [];
      let cursor: string | undefined;

      for (let step = 0; step < 5; step += 1) {
        const result = await repo.listRecipients({
          businessId: F.A,
          limit: 2,
          cursor,
        });

        seen.push(...ids(result.data));
        if (!result.hasMore) break;
        cursor = result.nextCursor ?? undefined;
      }

      expect(seen).toEqual([F.dAna, F.dDiego, F.dEva, F.dZeca, F.dBruno]);
    });

    it("continues right after a cursor whose driver the filter no longer shows, losing no one", async () => {
      const { repo } = harness();

      // Carla is inactive: "Carla" sits between "Ana Souza" and "Diego". The
      // next page starts at Diego. Prisma's `cursor + skip: 1` used to anchor
      // on her row and drop Diego, a colleague silently missing.
      const result = await repo.listRecipients({
        businessId: F.A,
        limit: 10,
        cursor: F.dCarla,
      });

      expect(ids(result.data)).toEqual([F.dDiego, F.dEva, F.dZeca, F.dBruno]);

      // The same under the app filter, which Carla also fails now.
      const withApp = await repo.listRecipients({
        businessId: F.A,
        app: "WITH_APP",
        limit: 10,
        cursor: F.dCarla,
      });

      expect(ids(withApp.data)).toEqual([F.dZeca]);
    });

    it("does not position on another company's driver", async () => {
      const { repo } = harness();

      const result = await repo.listRecipients({
        businessId: F.A,
        limit: 10,
        cursor: F.dB,
      });

      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("answers nothing after a cursor that does not exist", async () => {
      const { repo } = harness();

      const result = await repo.listRecipients({
        businessId: F.A,
        limit: 10,
        cursor: F.threadMissing,
      });

      expect(result.data).toEqual([]);
      expect(result.hasMore).toBe(false);
    });

    it("counts and lists the audience the notice reaches", async () => {
      const { repo } = harness();

      expect(await repo.countAudience(F.A)).toEqual({
        withApp: 2,
        withoutApp: 3,
      });
      expect(await repo.countAudience(F.B)).toEqual({
        withApp: 1,
        withoutApp: 0,
      });
      expect(await repo.listAudience(F.A, 10)).toEqual([
        { id: F.dAna, name: "Ana Souza", appUserId: F.uAna },
        { id: F.dZeca, name: "Zeca", appUserId: F.uZeca },
      ]);
      expect(ids(await repo.listAudience(F.A, 1))).toEqual([F.dAna]);
    });
  });

  describe("routes", () => {
    it("finds the running route per driver of the company, the last started first", async () => {
      const { repo } = harness();

      const running = await repo.findRunningRoutes(F.A, [
        F.dAna,
        F.dZeca,
        F.dBruno,
        F.dB,
      ]);

      expect(
        Object.fromEntries(
          [...running].map(([driver, route]) => [driver, route.id]),
        ),
      ).toEqual({
        [F.dAna]: F.rRun,
        [F.dZeca]: F.rZecaOld,
      });
      expect(running.get(F.dAna)).toEqual({
        id: F.rRun,
        businessId: F.A,
        driverId: F.dAna,
        code: 2,
        name: "Rota em curso",
      });
      expect((await repo.findRunningRoutes(F.A, [])).size).toBe(0);
    });

    it("tags a delivery with the driver's open route before a newer finished one", async () => {
      const { repo } = harness();

      expect(
        (await repo.findDeliveryRouteOfDriver(F.A, F.dAna, F.dl1))?.id,
      ).toBe(F.rRun);
      expect(
        await repo.findDeliveryRouteOfDriver(F.A, F.dZeca, F.dl1),
      ).toBeNull();
      expect(
        await repo.findDeliveryRouteOfDriver(F.B, F.dAna, F.dl1),
      ).toBeNull();
      expect((await repo.findRoute(F.rB))?.businessId).toBe(F.B);
      expect(await repo.findRoute(F.rMissing)).toBeNull();
    });
  });

  // Writes last: they add rows the reads above would count.
  describe("writes", () => {
    it("converges two first messages on one thread", async () => {
      const { repo } = harness();

      const [one, two] = await Promise.all([
        repo.getOrCreateThread(F.A, F.dDiego),
        repo.getOrCreateThread(F.A, F.dDiego),
      ]);

      expect(one.id).toBe(two.id);
      expect(one).toMatchObject({
        businessId: F.A,
        driverId: F.dDiego,
        last_message_at: null,
      });
      expect((await repo.getOrCreateThread(F.A, F.dAna)).id).toBe(F.tAna);
    });

    it("stores a message and moves the thread to its instant", async () => {
      const { repo } = harness();

      const message = await repo.createMessage({
        threadId: F.tZeca,
        senderId: F.staffA,
        kind: "TEXT",
        body: "Bom dia",
        attachment_key: null,
        duration_ms: null,
        deliveryId: null,
        broadcast_id: null,
        client_submission_id: "chat-contract-new-1",
      });

      expect(message).toMatchObject({
        routeId: null,
        ticketId: null,
        deliveryId: null,
        threadId: F.tZeca,
      });
      expect((await repo.findThreadById(F.tZeca))?.last_message_at).toEqual(
        message.created_at,
      );
      expect((await repo.findMessageById(message.id))?.body).toBe("Bom dia");
    });

    it("refuses an idempotency key used in any company (P2002) and a missing thread (P2003)", async () => {
      const { repo } = harness();
      const base = {
        senderId: F.staffA,
        kind: "TEXT" as const,
        body: "de novo",
        attachment_key: null,
        duration_ms: null,
        deliveryId: null,
        broadcast_id: null,
      };

      await expectPrismaCode(
        repo.createMessage({
          ...base,
          threadId: F.tAna,
          client_submission_id: "chat-contract-b-1",
        }),
        "P2002",
      );
      await expectPrismaCode(
        repo.createMessage({
          ...base,
          threadId: F.threadMissing,
          client_submission_id: null,
        }),
        "P2003",
      );
    });

    it("advances the read cursor and never rewinds it", async () => {
      const { repo } = harness();
      const unreadFor = async (userId: string) =>
        (
          await repo.listThreads({
            businessId: F.A,
            requesterUserId: userId,
            driverId: F.dAna,
            page: 1,
            pageSize: 1,
          })
        ).totalUnread;

      await repo.markThreadRead(F.tAna, F.staffA2, at(30));
      expect(await unreadFor(F.staffA2)).toBe(0);

      await repo.markThreadRead(F.tAna, F.staffA2, at(15));
      expect(await unreadFor(F.staffA2)).toBe(0);

      await expectPrismaCode(
        repo.markThreadRead(F.threadMissing, F.staffA2, at(30)),
        "P2003",
      );
    });

    it("advances each side's delivery cursor and never rewinds it", async () => {
      const { repo } = harness();

      await repo.markThreadDelivered(F.tBruno, at(10), "DRIVER");
      await repo.markThreadDelivered(F.tBruno, at(5), "DRIVER");
      await repo.markThreadDelivered(F.tBruno, at(7), "STAFF");
      await repo.markThreadDelivered(F.threadMissing, at(7), "STAFF");

      expect(await repo.findThreadById(F.tBruno)).toMatchObject({
        driver_delivered_at: at(10),
        staff_delivered_at: at(7),
      });

      const staffView = await repo.listMessages({
        threadId: F.tBruno,
        viewerIsDriverSide: false,
        limit: 1,
      });
      const driverView = await repo.listMessages({
        threadId: F.tBruno,
        viewerIsDriverSide: true,
        limit: 1,
      });

      expect(staffView.counterpartDeliveredAt).toEqual(at(10));
      expect(driverView.counterpartDeliveredAt).toEqual(at(7));
    });
  });
}

export {
  CHAT_FIXTURE,
  DRIVERS as CHAT_DRIVERS,
  MESSAGES as CHAT_MESSAGES,
  READS as CHAT_READS,
  ROUTES as CHAT_ROUTES,
  STOPS as CHAT_STOPS,
  THREADS as CHAT_THREADS,
  USERS as CHAT_USERS,
  chatRepositoryContract,
};
export type { ChatHarness };
