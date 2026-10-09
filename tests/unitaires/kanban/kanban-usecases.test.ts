import "reflect-metadata";

import { beforeEach, describe, expect, it, vi } from "vitest";

// The card use cases open a transaction on the real client for the outbox;
// here it runs the callback with a stand-in client (the outbox is a spy).
vi.mock("@/../infra/database", () => ({
  default: { $transaction: (callback: (tx: unknown) => unknown) => callback({}) },
}));

import { InMemoryKanbanRepository } from "@/modules/kanban/repositories/in-memory/in-memory-kanban-repository";

import { CreateKanbanColumnUseCase } from "@/modules/kanban/usecases/create-column/create-column-usecase";
import { UpdateKanbanColumnUseCase } from "@/modules/kanban/usecases/update-column/update-column-usecase";
import { DeleteKanbanColumnUseCase } from "@/modules/kanban/usecases/delete-column/delete-column-usecase";
import { ReorderKanbanColumnsUseCase } from "@/modules/kanban/usecases/reorder-columns/reorder-columns-usecase";
import { ListKanbanUseCase } from "@/modules/kanban/usecases/list-kanban/list-kanban-usecase";
import { CreateKanbanCardUseCase } from "@/modules/kanban/usecases/create-card/create-card-usecase";
import { UpdateKanbanCardUseCase } from "@/modules/kanban/usecases/update-card/update-card-usecase";
import { DeleteKanbanCardUseCase } from "@/modules/kanban/usecases/delete-card/delete-card-usecase";
import { ReorderKanbanCardsUseCase } from "@/modules/kanban/usecases/reorder-cards/reorder-cards-usecase";

import { KanbanNotAllowedCreateColumnBusinessError } from "@/modules/kanban/usecases/errors/kanban-not-allowed-create-column-business-error";
import { KanbanNotAllowedDeleteColumnBusinessError } from "@/modules/kanban/usecases/errors/kanban-not-allowed-delete-column-business-error";
import { KanbanInvalidPositionError } from "@/modules/kanban/usecases/errors/kanban-invalid-position-error";
import { KanbanOneOrMoreColumnNotBelongBusinessError } from "@/modules/kanban/usecases/errors/kanban-one-or-more-column-not-belong-business-error";
import { KanbanNotAllowedPermissionViewBusinessBoardError } from "@/modules/kanban/usecases/errors/kanban-not-allowed-permission-view-business-board-error";
import { KanbanCardCrossBoardMoveError } from "@/modules/kanban/usecases/errors/kanban-card-cross-board-move-error";
import { KanbanColumnNotFoundError } from "@/modules/kanban/usecases/errors/kanban-column-not-found-error";
import { KanbanCardNotFoundError } from "@/modules/kanban/usecases/errors/kanban-card-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";
import { UserNotBelongBusinessError } from "@/modules/user/usecases/errors/user-not-belong-business-error";
import { UserAssignedUserNotFoundError } from "@/modules/user/usecases/errors/user-assigned-user-not-found-error";
import { AppError } from "@/shared/errors/AppError";

/**
 * The nine Kanban use cases (CRIT-16) over the in-memory board: positions,
 * tenant walls, the per-user view and the outbox/activity side effects.
 */
const A = "018fe900-0000-7000-8000-00000000000a";
const B = "018fe900-0000-7000-8000-00000000000b";

interface TestUser {
  id: string;
  role: string;
  businessId: string | null;
  profileAccess?: { permissions: Array<{ permissionKey: string; canRead: boolean }> };
}

const people: Record<string, TestUser> = {
  master: { id: "master", role: "MASTER", businessId: null },
  adminA: { id: "adminA", role: "BUSINESS_ADMIN", businessId: A },
  adminB: { id: "adminB", role: "BUSINESS_ADMIN", businessId: B },
  readerA: {
    id: "readerA",
    role: "BUSINESS_USER",
    businessId: A,
    profileAccess: { permissions: [{ permissionKey: "kanban_manage", canRead: true }] },
  },
  ownOnlyA: { id: "ownOnlyA", role: "BUSINESS_USER", businessId: A },
  workerB: { id: "workerB", role: "BUSINESS_USER", businessId: B },
};

let board: InMemoryKanbanRepository;
let outbox: { publish: ReturnType<typeof vi.fn> };
let notifications: { createActivityIfEnabled: ReturnType<typeof vi.fn> };

const users = {
  findUserById: async (id: string) => people[id] ?? null,
} as never;

const businesses = {
  findBusinessById: async (id: string) =>
    id === A || id === B
      ? {
          id,
          corporate_reason: `Empresa ${id.slice(-1)}`,
          // B operates in Manaus; A leaves the zone to the default.
          ...(id === B && { timezone: "America/Manaus" }),
        }
      : null,
} as never;

const useCases = () => ({
  createColumn: new CreateKanbanColumnUseCase(users, businesses, board),
  updateColumn: new UpdateKanbanColumnUseCase(users, businesses, board),
  deleteColumn: new DeleteKanbanColumnUseCase(users, businesses, board),
  reorderColumns: new ReorderKanbanColumnsUseCase(users, businesses, board),
  list: new ListKanbanUseCase(users, businesses, board),
  createCard: new CreateKanbanCardUseCase(users, board, outbox as never, businesses),
  updateCard: new UpdateKanbanCardUseCase(users, board, outbox as never, businesses),
  deleteCard: new DeleteKanbanCardUseCase(users, board, notifications as never),
  reorderCards: new ReorderKanbanCardsUseCase(users, board),
});

const card = (columnId: string, title: string, assignedUserId?: string) => ({
  title,
  description: "Descrição",
  priority: "high",
  dueDate: "2026-10-01T12:00:00.000Z",
  columnId,
  ...(assignedUserId && { assignedUserId }),
});

beforeEach(() => {
  board = new InMemoryKanbanRepository();
  outbox = { publish: vi.fn() };
  notifications = { createActivityIfEnabled: vi.fn() };

  for (const person of Object.values(people)) {
    board.users.set(person.id, {
      id: person.id,
      name: person.id,
      email: `${person.id}@exemplo.com.br`,
      avatar: null,
    });
  }
});

describe("columns", () => {
  it("append at the end of each company's board, independently", async () => {
    const { createColumn } = useCases();

    const a0 = await createColumn.execute({ title: "A fazer", color: "#f00", businessId: A }, "adminA");
    const a1 = await createColumn.execute({ title: "Fazendo", color: "#0f0", businessId: A }, "adminA");
    const b0 = await createColumn.execute({ title: "Pendente", color: "#00f", businessId: B }, "adminB");

    expect([a0.position, a1.position, b0.position]).toEqual([0, 1, 0]);
  });

  it("refuse a manager writing on another company's board", async () => {
    const { createColumn } = useCases();

    await expect(
      createColumn.execute({ title: "Invasão", color: "#000", businessId: B }, "adminA"),
    ).rejects.toBeInstanceOf(KanbanNotAllowedCreateColumnBusinessError);

    await expect(
      createColumn.execute(
        { title: "Sem empresa", color: "#000", businessId: "018fe900-0000-7000-8000-0000000000ff" },
        "master",
      ),
    ).rejects.toBeInstanceOf(BusinessNotFoundError);

    expect(board.columns).toHaveLength(0);
  });

  it("are not edited through another company's path, not even by the MASTER", async () => {
    const { createColumn, updateColumn } = useCases();

    const columnB = await createColumn.execute({ title: "B", color: "#000", businessId: B }, "adminB");

    // The old rule exempted the MASTER: a column of B renamed through A's path.
    // Not on the path's board = not found, as a missing id (decision 11.3).
    await expect(
      updateColumn.execute({ title: "Renomeada" }, columnB.id, A, "master"),
    ).rejects.toBeInstanceOf(KanbanColumnNotFoundError);

    await expect(
      updateColumn.execute({ title: "Renomeada" }, columnB.id, A, "adminA"),
    ).rejects.toBeInstanceOf(KanbanColumnNotFoundError);

    expect(board.columns[0].title).toBe("B");

    await updateColumn.execute({ title: "Renomeada" }, columnB.id, B, "master");
    expect(board.columns[0].title).toBe("Renomeada");
  });

  it("delete with their cards and close the gap in the positions", async () => {
    const { createColumn, deleteColumn, createCard } = useCases();

    const first = await createColumn.execute({ title: "1", color: "#000", businessId: A }, "adminA");
    const middle = await createColumn.execute({ title: "2", color: "#000", businessId: A }, "adminA");
    const last = await createColumn.execute({ title: "3", color: "#000", businessId: A }, "adminA");

    await createCard.execute(card(middle.id, "vai junto"), "adminA");

    await deleteColumn.execute(middle.id, A, "adminA");

    expect(board.columns.map((column) => [column.id, column.position])).toEqual([
      [first.id, 0],
      [last.id, 1],
    ]);
    expect(board.cards).toHaveLength(0);
  });

  it("refuse deleting another company's column", async () => {
    const { createColumn, deleteColumn } = useCases();

    const columnA = await createColumn.execute({ title: "A", color: "#000", businessId: A }, "adminA");

    await expect(deleteColumn.execute(columnA.id, B, "adminB")).rejects.toBeInstanceOf(
      KanbanColumnNotFoundError,
    );
    await expect(deleteColumn.execute(columnA.id, A, "adminB")).rejects.toBeInstanceOf(
      KanbanNotAllowedDeleteColumnBusinessError,
    );

    expect(board.columns).toHaveLength(1);
  });

  it("reorder only with distinct positions and only the company's own columns", async () => {
    const { createColumn, reorderColumns } = useCases();

    const x = await createColumn.execute({ title: "X", color: "#000", businessId: A }, "adminA");
    const y = await createColumn.execute({ title: "Y", color: "#000", businessId: A }, "adminA");
    const foreign = await createColumn.execute({ title: "Z", color: "#000", businessId: B }, "adminB");

    await expect(
      reorderColumns.execute(
        { businessId: A, columns: [{ id: x.id, position: 0 }, { id: y.id, position: 0 }] },
        "adminA",
      ),
    ).rejects.toBeInstanceOf(KanbanInvalidPositionError);

    await expect(
      reorderColumns.execute(
        { businessId: A, columns: [{ id: x.id, position: 1 }, { id: foreign.id, position: 0 }] },
        "adminA",
      ),
    ).rejects.toBeInstanceOf(KanbanOneOrMoreColumnNotBelongBusinessError);

    await reorderColumns.execute(
      { businessId: A, columns: [{ id: x.id, position: 1 }, { id: y.id, position: 0 }] },
      "adminA",
    );

    const { data } = await board.findColumnsByBusinessId(A);
    expect(data.map((column) => column.title)).toEqual(["Y", "X"]);
    expect(board.columns.find((column) => column.id === foreign.id)?.position).toBe(0);
  });
});

describe("the board listing", () => {
  it("shows every card to a reader with kanban read, and only their own cards otherwise", async () => {
    const { createColumn, createCard, list } = useCases();

    const column = await createColumn.execute({ title: "Col", color: "#000", businessId: A }, "adminA");
    await createCard.execute(card(column.id, "da Ana", "ownOnlyA"), "adminA");
    await createCard.execute(card(column.id, "de todos"), "adminA");

    const reader = await list.execute({ businessId: A, userId: "readerA" });
    expect(reader.data[0].cards?.map((c) => c.title)).toEqual(["da Ana", "de todos"]);

    const own = await list.execute({ businessId: A, userId: "ownOnlyA" });
    expect(own.data[0].cards?.map((c) => c.title)).toEqual(["da Ana"]);
  });

  it("refuses another company's board and finds cards by a priority word", async () => {
    const { createColumn, createCard, list } = useCases();

    const column = await createColumn.execute({ title: "Col", color: "#000", businessId: A }, "adminA");
    await createCard.execute({ ...card(column.id, "urgente"), priority: "urgent" }, "adminA");
    await createCard.execute({ ...card(column.id, "calma"), priority: "low" }, "adminA");

    await expect(list.execute({ businessId: A, userId: "workerB" })).rejects.toBeInstanceOf(
      KanbanNotAllowedPermissionViewBusinessBoardError,
    );

    const found = await list.execute({ businessId: A, userId: "adminA", search: "baixa" });
    expect(found.data[0].cards?.map((c) => c.title)).toEqual(["calma"]);
  });
});

describe("cards", () => {
  it("append at the end of their column and publish the event with the board's company", async () => {
    const { createColumn, createCard } = useCases();

    const column = await createColumn.execute({ title: "Col", color: "#000", businessId: A }, "adminA");

    const first = await createCard.execute(card(column.id, "1"), "adminA");
    const second = await createCard.execute(card(column.id, "2", "readerA"), "adminA");

    expect([first.position, second.position]).toEqual([0, 1]);
    expect(outbox.publish).toHaveBeenCalledTimes(2);
    expect(outbox.publish.mock.calls[1][1]).toMatchObject({
      topic: "kanban-card.created",
      businessId: A,
      payload: { assignedUserId: "readerA" },
    });
  });

  it("carry the board's zone, so the message prints the due day of that company", async () => {
    const { createColumn, createCard, updateCard } = useCases();

    const column = await createColumn.execute({ title: "Col", color: "#000", businessId: B }, "adminB");
    const created = await createCard.execute(card(column.id, "1", "workerB"), "adminB");

    await updateCard.execute({ title: "1 revisto" }, created.id, "adminB");

    expect(outbox.publish.mock.calls.map((call) => call[1].payload.timeZone)).toEqual([
      "America/Manaus",
      "America/Manaus",
    ]);
  });

  it("are never assigned to another company's user, not even by the MASTER", async () => {
    const { createColumn, createCard, updateCard } = useCases();

    const column = await createColumn.execute({ title: "Col", color: "#000", businessId: A }, "adminA");

    // The old rule exempted the MASTER: B's worker would be paged about A's board.
    await expect(
      createCard.execute(card(column.id, "cruzado", "workerB"), "master"),
    ).rejects.toBeInstanceOf(UserNotBelongBusinessError);

    const own = await createCard.execute(card(column.id, "próprio"), "master");

    await expect(
      updateCard.execute({ assignedUserId: "workerB" }, own.id, "master"),
    ).rejects.toBeInstanceOf(UserNotBelongBusinessError);

    expect(board.cards.map((c) => c.assignedUserId)).toEqual([null]);
  });

  it("refuse another company's column and a missing one", async () => {
    const { createColumn, createCard } = useCases();

    const columnA = await createColumn.execute({ title: "Col", color: "#000", businessId: A }, "adminA");

    await expect(createCard.execute(card(columnA.id, "x"), "adminB")).rejects.toBeInstanceOf(
      KanbanColumnNotFoundError,
    );
    await expect(
      createCard.execute(card("018fe900-0000-7000-8000-0000000000ee", "x"), "adminA"),
    ).rejects.toBeInstanceOf(KanbanColumnNotFoundError);
  });

  it("delete closing the gap in their column and record the activity", async () => {
    const { createColumn, createCard, deleteCard } = useCases();

    const column = await createColumn.execute({ title: "Col", color: "#000", businessId: A }, "adminA");
    const c0 = await createCard.execute(card(column.id, "0"), "adminA");
    const c1 = await createCard.execute(card(column.id, "1"), "adminA");
    const c2 = await createCard.execute(card(column.id, "2"), "adminA");

    await deleteCard.execute(c1.id, "adminA");

    expect(board.cards.map((c) => [c.id, c.position])).toEqual([
      [c0.id, 0],
      [c2.id, 1],
    ]);
    expect(notifications.createActivityIfEnabled).toHaveBeenCalledWith(
      expect.objectContaining({ type: "Card Kanban", action: "delete", businessId: A }),
    );

    await expect(deleteCard.execute(c1.id, "adminA")).rejects.toBeInstanceOf(
      KanbanCardNotFoundError,
    );
  });

  it("move only inside one company's board", async () => {
    const { createColumn, createCard, reorderCards } = useCases();

    const columnA = await createColumn.execute({ title: "A", color: "#000", businessId: A }, "adminA");
    const otherA = await createColumn.execute({ title: "A2", color: "#000", businessId: A }, "adminA");
    const columnB = await createColumn.execute({ title: "B", color: "#000", businessId: B }, "adminB");

    const cardA = await createCard.execute(card(columnA.id, "a"), "adminA");

    await expect(
      reorderCards.execute({ cards: [{ id: cardA.id, position: 0, columnId: columnB.id }] }, "master"),
    ).rejects.toBeInstanceOf(KanbanCardCrossBoardMoveError);

    await reorderCards.execute(
      { cards: [{ id: cardA.id, position: 0, columnId: otherA.id }] },
      "adminA",
    );

    expect(board.cards[0].columnId).toBe(otherA.id);
  });
});

describe("InMemoryKanbanRepository answers like the repository", () => {
  it("raises the not-found errors for a missing row and cascades a column's cards", async () => {
    await expect(board.deleteColumn("018fe900-0000-7000-8000-0000000000dd")).rejects.toBeInstanceOf(
      KanbanColumnNotFoundError,
    );

    const column = await board.createColumn({ title: "C", color: "#000", businessId: A });
    await board.createCard({ ...card(column.id, "x") });

    await board.deleteColumn(column.id);

    expect(board.cards).toHaveLength(0);
    await expect(board.createCard(card(column.id, "órfão"))).rejects.toBeInstanceOf(
      KanbanColumnNotFoundError,
    );
  });

  it("refuses a move naming a missing card or column without moving anything", async () => {
    const column = await board.createColumn({ title: "C", color: "#000", businessId: A });
    const other = await board.createColumn({ title: "D", color: "#000", businessId: A });
    const kept = await board.createCard(card(column.id, "fica"));

    await expect(
      board.reorderCards({
        cards: [
          { id: kept.id, position: 0, columnId: other.id },
          { id: kept.id, position: 1, columnId: "018fe900-0000-7000-8000-0000000000cc" },
        ],
      }),
    ).rejects.toBeInstanceOf(KanbanColumnNotFoundError);

    await expect(
      board.reorderCards({
        cards: [
          { id: kept.id, position: 3, columnId: other.id },
          { id: "018fe900-0000-7000-8000-0000000000cb", position: 0, columnId: other.id },
        ],
      }),
    ).rejects.toBeInstanceOf(KanbanCardNotFoundError);

    expect(board.cards[0]).toMatchObject({ columnId: column.id, position: 0 });

    await expect(
      board.updateCard({ cardData: { title: "x" }, cardId: "018fe900-0000-7000-8000-0000000000ca" }),
    ).rejects.toBeInstanceOf(KanbanCardNotFoundError);

    await expect(
      board.reorderColumns({
        businessId: A,
        columns: [
          { id: column.id, position: 5 },
          { id: "018fe900-0000-7000-8000-0000000000c9", position: 0 },
        ],
      }),
    ).rejects.toBeInstanceOf(KanbanOneOrMoreColumnNotBelongBusinessError);

    expect(board.columns.find((item) => item.id === column.id)?.position).toBe(0);
  });
});

/**
 * Another company's column or card answers exactly as a missing one
 * (decision 11.3): same class, status, code and sentence. The old answer
 * was a 403 "não pertence a esta empresa" for an id that exists elsewhere
 * and a 404 for one that does not: an oracle for other boards' ids.
 */
describe("another company's ids are not found, never 'not yours'", () => {
  const MISSING = "018fe900-0000-7000-8000-0000000000ee";

  const answer = async (run: () => Promise<unknown>) => {
    const error = await run().then(
      () => null,
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AppError);

    const { statusCode, code, message } = error as AppError;

    return { statusCode, code, message };
  };

  it("for a card: update, delete and move", async () => {
    const { createColumn, createCard, updateCard, deleteCard, reorderCards } = useCases();

    const columnA = await createColumn.execute({ title: "A", color: "#000", businessId: A }, "adminA");
    const columnB = await createColumn.execute({ title: "B", color: "#000", businessId: B }, "adminB");
    const cardA = await createCard.execute(card(columnA.id, "de A"), "adminA");

    const missing = await answer(() => updateCard.execute({ title: "x" }, MISSING, "adminB"));

    expect(missing).toEqual({
      statusCode: 404,
      code: "KANBAN_CARD_NOT_FOUND",
      message: "Card do kanban não encontrado.",
    });
    expect(await answer(() => updateCard.execute({ title: "x" }, cardA.id, "adminB"))).toEqual(missing);
    expect(await answer(() => deleteCard.execute(cardA.id, "adminB"))).toEqual(missing);
    expect(await answer(() => deleteCard.execute(MISSING, "adminB"))).toEqual(missing);
    expect(
      await answer(() =>
        reorderCards.execute({ cards: [{ id: cardA.id, position: 0, columnId: columnB.id }] }, "adminB"),
      ),
    ).toEqual(missing);

    // Their own card onto A's column: the foreign column is the missing end.
    const cardB = await createCard.execute(card(columnB.id, "de B"), "adminB");
    const columnMissing = await answer(() =>
      reorderCards.execute({ cards: [{ id: cardB.id, position: 0, columnId: MISSING }] }, "adminB"),
    );

    expect(columnMissing).toMatchObject({ statusCode: 404, code: "KANBAN_COLUMN_NOT_FOUND" });
    expect(
      await answer(() =>
        reorderCards.execute({ cards: [{ id: cardB.id, position: 0, columnId: columnA.id }] }, "adminB"),
      ),
    ).toEqual(columnMissing);

    expect(board.cards.find((c) => c.id === cardA.id)).toMatchObject({
      title: "de A",
      columnId: columnA.id,
    });
  });

  it("for a column: create a card in it, edit or delete it through one's own path", async () => {
    const { createColumn, createCard, updateColumn, deleteColumn } = useCases();

    const columnA = await createColumn.execute({ title: "A", color: "#000", businessId: A }, "adminA");

    const missing = await answer(() => createCard.execute(card(MISSING, "x"), "adminB"));

    expect(missing).toEqual({
      statusCode: 404,
      code: "KANBAN_COLUMN_NOT_FOUND",
      message: "Coluna do kanban não encontrada.",
    });
    expect(await answer(() => createCard.execute(card(columnA.id, "x"), "adminB"))).toEqual(missing);
    expect(await answer(() => updateColumn.execute({ title: "x" }, columnA.id, B, "adminB"))).toEqual(
      missing,
    );
    expect(await answer(() => updateColumn.execute({ title: "x" }, MISSING, B, "adminB"))).toEqual(missing);
    expect(await answer(() => deleteColumn.execute(columnA.id, B, "adminB"))).toEqual(missing);
    expect(await answer(() => deleteColumn.execute(MISSING, B, "adminB"))).toEqual(missing);

    expect(board.columns).toHaveLength(1);
    expect(board.cards).toHaveLength(0);
  });

  it("names another company's board by path: a permission refusal, whatever column id comes with it", async () => {
    const { createColumn, updateColumn, deleteColumn, list } = useCases();

    const columnA = await createColumn.execute({ title: "A", color: "#000", businessId: A }, "adminA");

    const real = await answer(() => deleteColumn.execute(columnA.id, A, "adminB"));

    expect(real).toMatchObject({ statusCode: 403, code: "PERMISSION_DENIED" });
    expect(await answer(() => deleteColumn.execute(MISSING, A, "adminB"))).toEqual(real);
    expect(await answer(() => updateColumn.execute({ title: "x" }, MISSING, A, "adminB"))).toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
    expect(await answer(() => list.execute({ businessId: A, userId: "workerB" }))).toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
    });
  });

  it("for an assignee of another company: 'not found' for a manager, the reason for the MASTER", async () => {
    const { createColumn, createCard, updateCard } = useCases();

    const columnA = await createColumn.execute({ title: "A", color: "#000", businessId: A }, "adminA");
    const own = await createCard.execute(card(columnA.id, "próprio"), "adminA");

    await expect(createCard.execute(card(columnA.id, "x", "workerB"), "adminA")).rejects.toBeInstanceOf(
      UserAssignedUserNotFoundError,
    );
    await expect(createCard.execute(card(columnA.id, "x", "ninguem"), "adminA")).rejects.toBeInstanceOf(
      UserAssignedUserNotFoundError,
    );
    await expect(
      updateCard.execute({ assignedUserId: "workerB" }, own.id, "adminA"),
    ).rejects.toBeInstanceOf(UserAssignedUserNotFoundError);

    await expect(createCard.execute(card(columnA.id, "x", "workerB"), "master")).rejects.toBeInstanceOf(
      UserNotBelongBusinessError,
    );

    expect(board.cards.map((c) => c.title)).toEqual(["próprio"]);
  });
});
