import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { sign } from "jsonwebtoken";

import { randomUUID } from "node:crypto";

import auth from "@/config/auth";
import { KanbanRepository } from "@/modules/kanban/repositories/kanban-repository";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * The Kanban board against Postgres (CRIT-16).
 *
 * - Positions: the next one was read and then inserted in two statements, so
 *   columns (or cards) created at once shared a position; a column delete
 *   reordered the rest after committing, outside any transaction.
 * - Tenant walls over HTTP: another company's board is refused, and a card is
 *   never assigned to a user of another company — not even by the MASTER.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const CARRIER = "018fea00-0000-7000-8000-00000000000a";
const OTHER = "018fea00-0000-7000-8000-00000000000b";

const repository = new KanbanRepository(prisma);

const tokens: Record<"admin" | "otherAdmin" | "master" | "readOnly", string> =
  {} as never;
const userIds: Record<"admin" | "otherAdmin" | "master" | "readOnly", string> =
  {} as never;

let cnpjSeq = 0;

async function seedBusiness(id: string) {
  cnpjSeq += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora Kanban ${id.slice(-1)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(83222555000180 + cnpjSeq),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
    },
  });
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER",
  businessId: string | null,
  profileAccessId?: string,
): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: `Usuário ${id.slice(0, 4)}`,
      email: `${id}@exemplo.com.br`,
      password: "not-used-here",
      role,
      businessId,
      profileAccessId: profileAccessId ?? null,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "15m" },
  );

  return { id, token };
}

async function positionsOf(businessId: string): Promise<number[]> {
  const columns = await prisma.kanbanColumn.findMany({
    where: { businessId },
    orderBy: { position: "asc" },
    select: { position: true },
  });

  return columns.map((column) => column.position);
}

const range = (n: number) => Array.from({ length: n }, (_, index) => index);

beforeAll(async () => {
  await seedBusiness(CARRIER);
  await seedBusiness(OTHER);

  const profile = await prisma.profileAccess.create({
    data: {
      name: `Perfil ${randomUUID().slice(0, 8)}`,
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "kanban_manage",
            action: "kanban_manage",
            canRead: true,
            canWrite: false,
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  for (const [key, role, businessId, profileId] of [
    ["admin", "BUSINESS_ADMIN", CARRIER, undefined],
    ["otherAdmin", "BUSINESS_ADMIN", OTHER, undefined],
    ["master", "MASTER", null, undefined],
    ["readOnly", "BUSINESS_USER", CARRIER, profile.id],
  ] as const) {
    const seeded = await seedUser(role, businessId, profileId);

    tokens[key] = seeded.token;
    userIds[key] = seeded.id;
  }

  ({ app } = await import("@/http"));
  await app.ready();
}, 90_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("board positions under concurrency", () => {
  it("gives columns created at the same moment distinct, contiguous positions", async () => {
    await Promise.all(
      range(8).map((index) =>
        repository.createColumn({
          title: `Coluna ${index}`,
          color: "#000000",
          businessId: CARRIER,
        }),
      ),
    );

    expect(await positionsOf(CARRIER)).toEqual(range(8));
  });

  it("gives cards created at the same moment distinct positions in their column", async () => {
    const column = await prisma.kanbanColumn.findFirstOrThrow({
      where: { businessId: CARRIER },
      orderBy: { position: "asc" },
    });

    await Promise.all(
      range(8).map((index) =>
        repository.createCard({
          title: `Card ${index}`,
          description: "Descrição",
          priority: "medium",
          dueDate: new Date("2026-10-01T12:00:00.000Z"),
          columnId: column.id,
        }),
      ),
    );

    const cards = await prisma.kanbanCard.findMany({
      where: { columnId: column.id },
      orderBy: { position: "asc" },
      select: { position: true },
    });

    expect(cards.map((card) => card.position)).toEqual(range(8));
  });

  it("closes the gap of a deleted column in the same transaction, even beside concurrent creates", async () => {
    const columns = await prisma.kanbanColumn.findMany({
      where: { businessId: CARRIER },
      orderBy: { position: "asc" },
    });

    // The first column holds the eight cards: they go with it (cascade).
    await Promise.all([
      repository.deleteColumn(columns[0].id),
      repository.deleteColumn(columns[3].id),
      repository.createColumn({
        title: "Nova 1",
        color: "#000000",
        businessId: CARRIER,
      }),
      repository.createColumn({
        title: "Nova 2",
        color: "#000000",
        businessId: CARRIER,
      }),
    ]);

    // 8 - 2 + 2 columns, positions 0..7 with no gap and no repeat.
    expect(await positionsOf(CARRIER)).toEqual(range(8));
    expect(
      await prisma.kanbanCard.count({ where: { columnId: columns[0].id } }),
    ).toBe(0);
  });

  it("closes the gap of a deleted card in its column", async () => {
    const column = await repository.createColumn({
      title: "Cartões",
      color: "#000000",
      businessId: CARRIER,
    });

    const created = [];

    for (const index of range(4)) {
      created.push(
        await repository.createCard({
          title: `c${index}`,
          description: "Descrição",
          priority: "low",
          dueDate: new Date("2026-10-01T12:00:00.000Z"),
          columnId: column.id,
        }),
      );
    }

    await repository.deleteCard(created[1].id);

    const cards = await prisma.kanbanCard.findMany({
      where: { columnId: column.id },
      orderBy: { position: "asc" },
      select: { title: true, position: true },
    });

    expect(cards).toEqual([
      { title: "c0", position: 0 },
      { title: "c2", position: 1 },
      { title: "c3", position: 2 },
    ]);
  });
});

describe("board tenant walls over HTTP", () => {
  it("refuses a manager creating a column on another company's board", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/kanban/column/create/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.otherAdmin}` },
      payload: { title: "Invasão", color: "#000000" },
    });

    expect(response.statusCode).toBe(403);
    expect(
      await prisma.kanbanColumn.count({ where: { title: "Invasão" } }),
    ).toBe(0);
  });

  it("refuses a read-only profile writing and lets it read the board", async () => {
    const write = await app.inject({
      method: "POST",
      url: `/kanban/column/create/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.readOnly}` },
      payload: { title: "Sem escrita", color: "#000000" },
    });

    expect(write.statusCode).toBe(403);

    const read = await app.inject({
      method: "GET",
      url: `/kanban/list/${CARRIER}`,
      headers: { authorization: `Bearer ${tokens.readOnly}` },
    });

    expect(read.statusCode).toBe(200);
  });

  it("never assigns a card to another company's user, not even for the MASTER", async () => {
    const column = await prisma.kanbanColumn.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    const response = await app.inject({
      method: "POST",
      url: "/kanban/card/create",
      headers: { authorization: `Bearer ${tokens.master}` },
      payload: {
        title: "Cruzado",
        description: "Descrição",
        priority: "high",
        dueDate: "2026-10-01T12:00:00.000Z",
        columnId: column.id,
        assignedUserId: userIds.otherAdmin,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(await prisma.kanbanCard.count({ where: { title: "Cruzado" } })).toBe(
      0,
    );
  });
});

/**
 * Another company's column or card over HTTP answers exactly like an id that
 * does not exist (decision 11.3): same status, same body, with a code. It was
 * 403 "não pertence a esta empresa" for a real id and 404 for a made-up one.
 */
describe("another company's ids over HTTP are not found", () => {
  const MISSING = "018fea00-0000-7000-8000-0000000000ee";

  const send = (
    method: "PATCH" | "DELETE" | "POST",
    url: string,
    payload?: Record<string, unknown>,
  ) =>
    app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${tokens.otherAdmin}` },
      payload,
    });

  const same = async (
    real: Awaited<ReturnType<typeof send>>,
    fake: Awaited<ReturnType<typeof send>>,
    code: string,
  ) => {
    expect(real.statusCode).toBe(404);
    expect(fake.statusCode).toBe(404);
    expect(real.json()).toEqual(fake.json());
    expect(real.json()).toMatchObject({ code });
  };

  it("for a card: update, delete and move", async () => {
    const column = await repository.createColumn({
      title: "Cartão alheio",
      color: "#000000",
      businessId: CARRIER,
    });
    const theirs = await repository.createCard({
      title: "Da transportadora",
      description: "Descrição",
      priority: "low",
      dueDate: new Date("2026-10-01T12:00:00.000Z"),
      columnId: column.id,
    });
    const own = await repository.createColumn({
      title: "Própria",
      color: "#000000",
      businessId: OTHER,
    });

    await same(
      await send("PATCH", `/kanban/card/update/${theirs.id}`, {
        title: "Invadido",
      }),
      await send("PATCH", `/kanban/card/update/${MISSING}`, {
        title: "Invadido",
      }),
      "KANBAN_CARD_NOT_FOUND",
    );

    await same(
      await send("DELETE", `/kanban/card/delete/${theirs.id}`),
      await send("DELETE", `/kanban/card/delete/${MISSING}`),
      "KANBAN_CARD_NOT_FOUND",
    );

    await same(
      await send("POST", "/kanban/cards/reorder", {
        cards: [{ id: theirs.id, position: 0, columnId: own.id }],
      }),
      await send("POST", "/kanban/cards/reorder", {
        cards: [{ id: MISSING, position: 0, columnId: own.id }],
      }),
      "KANBAN_CARD_NOT_FOUND",
    );

    expect(
      await prisma.kanbanCard.findUnique({ where: { id: theirs.id } }),
    ).toMatchObject({
      title: "Da transportadora",
      columnId: column.id,
    });
  });

  it("for a column: a card created in it, and edit or delete through one's own path", async () => {
    const theirs = await repository.createColumn({
      title: "Coluna alheia",
      color: "#000000",
      businessId: CARRIER,
    });

    const card = {
      title: "Plantado",
      description: "Descrição",
      priority: "high",
      dueDate: "2026-10-01T12:00:00.000Z",
    };

    await same(
      await send("POST", "/kanban/card/create", {
        ...card,
        columnId: theirs.id,
      }),
      await send("POST", "/kanban/card/create", { ...card, columnId: MISSING }),
      "KANBAN_COLUMN_NOT_FOUND",
    );

    await same(
      await send(
        "PATCH",
        `/kanban/column/update/${theirs.id}/business/${OTHER}`,
        { title: "X" },
      ),
      await send(
        "PATCH",
        `/kanban/column/update/${MISSING}/business/${OTHER}`,
        { title: "X" },
      ),
      "KANBAN_COLUMN_NOT_FOUND",
    );

    await same(
      await send(
        "DELETE",
        `/kanban/column/delete/${theirs.id}/business/${OTHER}`,
      ),
      await send(
        "DELETE",
        `/kanban/column/delete/${MISSING}/business/${OTHER}`,
      ),
      "KANBAN_COLUMN_NOT_FOUND",
    );

    expect(
      await prisma.kanbanColumn.findUnique({ where: { id: theirs.id } }),
    ).toMatchObject({
      title: "Coluna alheia",
    });
    expect(
      await prisma.kanbanCard.count({ where: { title: "Plantado" } }),
    ).toBe(0);
  });

  it("naming another company's board in the path is refused the same way, whatever column id comes with it", async () => {
    const theirs = await prisma.kanbanColumn.findFirstOrThrow({
      where: { businessId: CARRIER },
    });

    const real = await send(
      "DELETE",
      `/kanban/column/delete/${theirs.id}/business/${CARRIER}`,
    );
    const fake = await send(
      "DELETE",
      `/kanban/column/delete/${MISSING}/business/${CARRIER}`,
    );

    // The route's tenant guard answers first (TENANT_ACCESS_DENIED), before
    // the use case looks the column up.
    expect(real.statusCode).toBe(403);
    expect(real.json()).toEqual(fake.json());
    expect(real.json().code).toEqual(expect.any(String));
    expect(await prisma.kanbanColumn.count({ where: { id: theirs.id } })).toBe(
      1,
    );
  });
});

/**
 * Holds a column's row lock from another connection until released, as a
 * concurrent writer would.
 */
function holdColumn(columnId: string) {
  const client = createPrismaClient();

  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  let acquired!: () => void;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });

  const done = client
    .$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "kanban_column" WHERE "id" = ${columnId} FOR UPDATE`;
        acquired();
        await released;
      },
      { timeout: 30_000, maxWait: 10_000 },
    )
    .finally(() => client.$disconnect());

  return { held, release, done };
}

/**
 * Waits until `count` backends are queued on a Kanban column lock. Filtered
 * by the lock query itself: the test database is shared with other suites.
 */
async function lockWaiters(count: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const [{ waiting }] = await prisma.$queryRaw<Array<{ waiting: number }>>`
      SELECT count(*)::int AS "waiting" FROM pg_stat_activity
      WHERE "datname" = current_database() AND "wait_event_type" = 'Lock'
        AND "query" LIKE '%FROM "kanban_column"%FOR UPDATE%'
    `;

    if (waiting >= count) return;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`nenhuma espera de lock (${count}) apareceu`);
}

describe("card writes under the lock of the column the card is in now", () => {
  const card = (columnId: string, title: string) =>
    repository.createCard({
      title,
      description: "Descrição",
      priority: "low",
      dueDate: new Date("2026-10-01T12:00:00.000Z"),
      columnId,
    });

  it("a delete whose card moved while it waited compacts the new column under that column's lock", async () => {
    const from = await repository.createColumn({
      title: "De",
      color: "#000000",
      businessId: OTHER,
    });
    const to = await repository.createColumn({
      title: "Para",
      color: "#000000",
      businessId: OTHER,
    });

    const moving = await card(from.id, "em trânsito");
    await card(to.id, "t0");
    await card(to.id, "t1");

    // 1. Someone holds the source column: the delete reads it and queues.
    const source = holdColumn(from.id);
    await source.held;

    let settled = false;
    const deleting = repository.deleteCard(moving.id).finally(() => {
      settled = true;
    });

    await lockWaiters(1);

    // 2. The card leaves for the other column meanwhile.
    await prisma.kanbanCard.update({
      where: { id: moving.id },
      data: { columnId: to.id, position: 2 },
    });

    // 3. Someone holds the destination; the source is released.
    const target = holdColumn(to.id);
    await target.held;

    source.release();
    await source.done;

    // The delete now waits for the destination's lock. The old code went on
    // with the column it had read and compacted the destination unlocked,
    // well inside this pause.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await lockWaiters(1);
    expect(settled, "a exclusão compactou a coluna nova sem o lock dela").toBe(
      false,
    );

    target.release();
    await target.done;
    await deleting;

    const left = await prisma.kanbanCard.findMany({
      where: { columnId: to.id },
      orderBy: { position: "asc" },
      select: { title: true, position: true },
    });

    expect(left).toEqual([
      { title: "t0", position: 0 },
      { title: "t1", position: 1 },
    ]);
    expect(await prisma.kanbanCard.count({ where: { id: moving.id } })).toBe(0);
  });

  it("a move to a column deleted meanwhile, and a delete of a card already gone, are not-found errors", async () => {
    const column = await repository.createColumn({
      title: "Some",
      color: "#000000",
      businessId: OTHER,
    });
    const kept = await card(column.id, "fica");

    const vanished = await repository.createColumn({
      title: "Vai sumir",
      color: "#000000",
      businessId: OTHER,
    });
    await repository.deleteColumn(vanished.id);

    // The old code met the FK error and the use case answered a generic 500.
    await expect(
      repository.reorderCards({
        cards: [{ id: kept.id, position: 0, columnId: vanished.id }],
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "KANBAN_COLUMN_NOT_FOUND",
    });

    await expect(repository.deleteColumn(vanished.id)).rejects.toMatchObject({
      statusCode: 404,
      code: "KANBAN_COLUMN_NOT_FOUND",
    });

    await repository.deleteCard(kept.id);

    await expect(repository.deleteCard(kept.id)).rejects.toMatchObject({
      statusCode: 404,
      code: "KANBAN_CARD_NOT_FOUND",
    });
    await expect(
      repository.updateCard({ cardData: { title: "x" }, cardId: kept.id }),
    ).rejects.toMatchObject({ statusCode: 404, code: "KANBAN_CARD_NOT_FOUND" });
  });
});
