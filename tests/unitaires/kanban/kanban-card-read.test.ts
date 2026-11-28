import { beforeEach, describe, expect, it } from "vitest";
import { v7 as uuidV7 } from "uuid";

import type { User } from "@/modules/user/dtos/user-dto";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryKanbanRepository } from "@/modules/kanban/repositories/in-memory/in-memory-kanban-repository";

import { GetKanbanCardUseCase } from "@/modules/kanban/usecases/get-card/get-card-usecase";

/**
 * GET /kanban/card/:id (wave 3): the card a notification opens in the app,
 * read only. The card still notifies the user it is designated to, a driver
 * included, while the driver has no board in any menu (D45): he reads that
 * card and no other. A full Kanban reader reads any card of the company;
 * everything else is the 404 of a card that exists nowhere.
 */
const CARRIER = "018f3500-0000-7000-8000-00000000000a";
const OTHER = "018f3500-0000-7000-8000-00000000000b";

const ADMIN = "018f3500-0000-7000-8000-0000000000a1";
const MASTER = "018f3500-0000-7000-8000-0000000000a2";
const DRIVER_USER = "018f3500-0000-7000-8000-0000000000a3";
const COLLEAGUE_USER = "018f3500-0000-7000-8000-0000000000a4";
const READER = "018f3500-0000-7000-8000-0000000000a5";
const OTHER_ADMIN = "018f3500-0000-7000-8000-0000000000a6";
// Office users whose profile does not read the board: one without the key at
// all, one with the key unreadable.
const OFFICE_NO_KEY = "018f3500-0000-7000-8000-0000000000a7";
const OFFICE_UNREADABLE = "018f3500-0000-7000-8000-0000000000a8";

const COLUMN = "018f3500-0000-7000-8000-0000000000c1";
const FOREIGN_COLUMN = "018f3500-0000-7000-8000-0000000000c2";

const CARD = {
  driver: "018f3500-0000-7000-8000-000000000001",
  colleague: "018f3500-0000-7000-8000-000000000002",
  foreign: "018f3500-0000-7000-8000-000000000003",
  officeNoKey: "018f3500-0000-7000-8000-000000000004",
  officeUnreadable: "018f3500-0000-7000-8000-000000000005",
};

let users: InMemoryUserRepository;
let kanban: InMemoryKanbanRepository;

beforeEach(() => {
  users = new InMemoryUserRepository();
  kanban = new InMemoryKanbanRepository();

  users.user.push(
    { id: ADMIN, role: "BUSINESS_ADMIN", businessId: CARRIER } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "driver-1",
    } as User,
    {
      id: COLLEAGUE_USER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: "driver-2",
    } as User,
    {
      id: READER,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      profileAccess: {
        name: "Tarefas",
        permissions: [
          { permissionKey: "kanban_manage", canRead: true, canWrite: false },
        ],
      },
    } as unknown as User,
    { id: OTHER_ADMIN, role: "BUSINESS_ADMIN", businessId: OTHER } as User,
    {
      id: OFFICE_NO_KEY,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      profileAccess: {
        name: "Financeiro",
        permissions: [
          {
            permissionKey: "account_payable_manage",
            canRead: true,
            canWrite: true,
          },
        ],
      },
    } as unknown as User,
    {
      id: OFFICE_UNREADABLE,
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      profileAccess: {
        name: "Tarefas ocultas",
        permissions: [
          { permissionKey: "kanban_manage", canRead: false, canWrite: false },
        ],
      },
    } as unknown as User,
  );

  const at = new Date("2026-10-20T12:00:00.000Z");

  kanban.columns.push(
    {
      id: COLUMN,
      title: "Em andamento",
      color: "#f59e0b",
      position: 0,
      businessId: CARRIER,
      created_at: at,
      updated_at: at,
    },
    {
      id: FOREIGN_COLUMN,
      title: "A fazer",
      color: "#3b82f6",
      position: 0,
      businessId: OTHER,
      created_at: at,
      updated_at: at,
    },
  );

  const card = (id: string, columnId: string, assignedUserId: string) => ({
    id,
    title: `Card ${id.slice(-1)}`,
    description: "Levar o caminhão para a revisão",
    priority: "high",
    dueDate: new Date("2026-11-10T03:00:00.000Z"),
    position: 0,
    columnId,
    assignedUserId,
    completed: false,
    created_at: at,
    updated_at: at,
  });

  kanban.cards.push(
    card(CARD.driver, COLUMN, DRIVER_USER),
    card(CARD.colleague, COLUMN, COLLEAGUE_USER),
    card(CARD.foreign, FOREIGN_COLUMN, OTHER_ADMIN),
    card(CARD.officeNoKey, COLUMN, OFFICE_NO_KEY),
    card(CARD.officeUnreadable, COLUMN, OFFICE_UNREADABLE),
  );
  kanban.users.set(DRIVER_USER, {
    id: DRIVER_USER,
    name: "Motorista",
    email: "motorista@exemplo.com.br",
    avatar: "https://exemplo.com.br/foto.jpg",
  });
});

const read = () => new GetKanbanCardUseCase(users, kanban);

async function expectNotFound(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    statusCode: 404,
    code: "KANBAN_CARD_NOT_FOUND",
  });
}

describe("GET /kanban/card/:id", () => {
  it("lets the designated driver read his card, with its column and no e-mail or photo", async () => {
    const card = await read().execute({
      userId: DRIVER_USER,
      cardId: CARD.driver,
    });

    expect(card).toMatchObject({
      id: CARD.driver,
      title: "Card 1",
      priority: "high",
      completed: false,
      column: { id: COLUMN, title: "Em andamento", color: "#f59e0b" },
      businessId: CARRIER,
      assignedUser: { id: DRIVER_USER, name: "Motorista" },
    });
    expect(JSON.stringify(card)).not.toContain("motorista@exemplo.com.br");
    expect(JSON.stringify(card)).not.toContain("foto.jpg");
  });

  it("answers a colleague's card to the driver as missing (no board for him, D45)", async () => {
    await expectNotFound(
      read().execute({ userId: DRIVER_USER, cardId: CARD.colleague }),
    );
  });

  it("lets a full Kanban reader and the admin read any card of the company", async () => {
    for (const userId of [READER, ADMIN]) {
      const card = await read().execute({ userId, cardId: CARD.colleague });

      expect(card.id).toBe(CARD.colleague);
    }
  });

  it.each([
    ["without the Kanban key", OFFICE_NO_KEY, CARD.officeNoKey],
    [
      "with the Kanban key unreadable",
      OFFICE_UNREADABLE,
      CARD.officeUnreadable,
    ],
  ])(
    "lets an office user %s read only the card designated to them",
    async (_label, userId, ownCard) => {
      const card = await read().execute({ userId, cardId: ownCard });

      expect(card).toMatchObject({
        id: ownCard,
        columnId: COLUMN,
        column: { id: COLUMN, title: "Em andamento", color: "#f59e0b" },
        businessId: CARRIER,
        assignedUserId: userId,
        completed: false,
      });

      // A colleague's card must not tell apart from an id that exists
      // nowhere: same status, code and message.
      const refusal = (cardId: string) =>
        read()
          .execute({ userId, cardId })
          .then(
            () => null,
            (error: { statusCode: number; code: string; message: string }) => ({
              statusCode: error.statusCode,
              code: error.code,
              message: error.message,
            }),
          );

      const colleague = await refusal(CARD.colleague);
      const unknown = await refusal(uuidV7());

      expect(colleague).toMatchObject({
        statusCode: 404,
        code: "KANBAN_CARD_NOT_FOUND",
      });
      expect(colleague).toEqual(unknown);
    },
  );

  it("answers another company's card and an unknown id as missing", async () => {
    await expectNotFound(
      read().execute({ userId: ADMIN, cardId: CARD.foreign }),
    );
    await expectNotFound(read().execute({ userId: ADMIN, cardId: uuidV7() }));
  });

  it("lets the MASTER read any card, narrowed to the company he names", async () => {
    const card = await read().execute({ userId: MASTER, cardId: CARD.foreign });

    expect(card.businessId).toBe(OTHER);

    await expectNotFound(
      read().execute({
        userId: MASTER,
        cardId: CARD.foreign,
        businessId: CARRIER,
      }),
    );
  });

  it("refuses a session user that no longer exists (404 USER_NOT_FOUND)", async () => {
    await expect(
      read().execute({ userId: uuidV7(), cardId: CARD.driver }),
    ).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
  });
});
