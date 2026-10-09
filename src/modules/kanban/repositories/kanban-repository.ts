import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

import { IKanbanRepository } from "./IKanban-repository";

import {
  KanbanColumn,
  CreateKanbanColumnProps,
  UpdateKanbanColumn,
  ReorderKanbanColumnsProps,
  KanbanCard,
  CreateKanbanCardProps,
  UpdateKanbanCard,
  ReorderKanbanCardsProps,
  MoveCardToColumnProps,
  ListKanbanColumnProps,
} from "../dtos/kanban-dto";

import { UploadService } from "@/shared/services/upload-service";
import { container } from "tsyringe";

import { buildSearchOr } from "@/shared/pagination/search-or";
import { KanbanColumnNotFoundError } from "../usecases/errors/kanban-column-not-found-error";
import { KanbanCardNotFoundError } from "../usecases/errors/kanban-card-not-found-error";
import { KanbanBoardChangedError } from "../usecases/errors/kanban-board-changed-error";
import { KanbanOneOrMoreColumnNotBelongBusinessError } from "../usecases/errors/kanban-one-or-more-column-not-belong-business-error";

/** A card left the column this transaction locked; run it again. */
const CARD_MOVED = Symbol("kanban-card-moved");

/** Moves racing one card this many times in a row mean a hot board, not a bug. */
const CARD_MOVE_ATTEMPTS = 3;

// Mapping priorities from Portuguese to English
const PRIORITY_MAPPING: Record<string, string[]> = {
  baixa: ["low"],
  média: ["medium"],
  media: ["medium"], // No accent
  alta: ["high"],
  urgente: ["urgent"],
};

// Helper function to get priorities based on search term
const getPrioritiesFromSearch = (searchTerm: string): string[] => {
  const normalizedTerm = searchTerm.toLowerCase().trim();

  // Search exact match
  if (PRIORITY_MAPPING[normalizedTerm]) {
    return PRIORITY_MAPPING[normalizedTerm];
  }

  // Fetch partial match
  for (const [key, values] of Object.entries(PRIORITY_MAPPING)) {
    if (key.includes(normalizedTerm) || normalizedTerm.includes(key)) {
      return values;
    }
  }

  return [];
};

class KanbanRepository implements IKanbanRepository {
  private uploadService: UploadService;

  constructor(private prisma = database) {
    this.uploadService = container.resolve(UploadService);
  }

  // Async because `getFileUrl` signs the R2 URL. `card` is `any`, so the
  // compiler would not notice a missing await: the avatar would serialize
  // as {}.
  private mapCard = async (
    card: any,
    sign: (key: string) => Promise<string> = (key) =>
      this.uploadService.getFileUrl(key),
  ): Promise<KanbanCard> => {
    return {
      ...card,
      dueDate: card.dueDate,
      completed: card.completed || false,
      created_at: card.created_at,
      updated_at: card.updated_at,
      assignedUser: card.assignedUser
        ? {
            ...card.assignedUser, // Keeps id, name, email
            avatar: card.assignedUser.avatar
              ? await sign(card.assignedUser.avatar)
              : null,
          }
        : null,
    };
  };

  /**
   * One signature per distinct avatar for a whole board: the same assignee
   * on forty cards was signed forty times.
   */
  private avatarSigner(): (key: string) => Promise<string> {
    const signed = new Map<string, Promise<string>>();

    return (key) => {
      let url = signed.get(key);

      if (!url) {
        url = this.uploadService.getFileUrl(key);
        signed.set(key, url);
      }

      return url;
    };
  }

  /** Prisma's "record to update/delete not found". */
  private static isMissingRow(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    );
  }

  /**
   * Serialises the structural writes of one company's board (create, delete
   * and reorder of columns) for the rest of the transaction. The next
   * position was read and then inserted in two statements, so two columns
   * created at once got the same position; a delete reordered the rest after
   * committing. There is no unique on (businessId, position) to lean on, and
   * an advisory lock keeps the business row itself free.
   */
  private async lockBoard(
    tx: Prisma.TransactionClient,
    businessId: string,
  ): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`kanban-board:${businessId}`}, 0))`;
  }

  /**
   * Locks a column row for the rest of the transaction: card positions in it
   * are computed and compacted by one writer at a time, and a column being
   * deleted meanwhile is seen as gone instead of taking a card with it.
   * Returns false when the column no longer exists.
   */
  private async lockColumn(
    tx: Prisma.TransactionClient,
    columnId: string,
  ): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "kanban_column" WHERE "id" = ${columnId} FOR UPDATE
    `;

    return rows.length > 0;
  }

  async createColumn(
    columnData: CreateKanbanColumnProps,
  ): Promise<KanbanColumn> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockBoard(tx, columnData.businessId);

      const last = await tx.kanbanColumn.findFirst({
        where: { businessId: columnData.businessId },
        orderBy: { position: "desc" },
        select: { position: true },
      });

      return tx.kanbanColumn.create({
        data: {
          ...columnData,
          position: columnData.position ?? (last ? last.position + 1 : 0),
        },
      });
    });
  }

  async updateColumn({
    columnData,
    columnId,
  }: UpdateKanbanColumn): Promise<KanbanColumn> {
    const filteredData = Object.fromEntries(
      Object.entries(columnData).filter(([_, value]) => value !== undefined),
    );

    try {
      return await this.prisma.kanbanColumn.update({
        where: { id: columnId },
        data: filteredData,
      });
    } catch (error) {
      // Deleted between the use case's read and this write.
      if (KanbanRepository.isMissingRow(error)) throw new KanbanColumnNotFoundError();

      throw error;
    }
  }

  /**
   * Deletes the column (its cards go with it, ON DELETE CASCADE) and closes
   * the gap in the positions, in ONE transaction under the board lock. The
   * reorder used to run after the delete had committed: a failure between
   * the two left a hole, and a column created in between got a position the
   * reorder then duplicated.
   */
  async deleteColumn(columnId: string): Promise<KanbanColumn> {
    return this.prisma.$transaction(async (tx) => {
      const target = await tx.kanbanColumn.findUnique({
        where: { id: columnId },
        select: { businessId: true },
      });

      if (!target) throw new KanbanColumnNotFoundError();

      await this.lockBoard(tx, target.businessId);

      // A concurrent delete of the same column won the lock: a 404, not a 500.
      const column = await tx.kanbanColumn
        .delete({ where: { id: columnId } })
        .catch((error: unknown) => {
          if (KanbanRepository.isMissingRow(error)) throw new KanbanColumnNotFoundError();
          throw error;
        });

      const remaining = await tx.kanbanColumn.findMany({
        where: { businessId: column.businessId },
        orderBy: [{ position: "asc" }, { created_at: "asc" }, { id: "asc" }],
        select: { id: true, position: true },
      });

      for (const [index, col] of remaining.entries()) {
        if (col.position === index) continue;

        await tx.kanbanColumn.update({
          where: { id: col.id },
          data: { position: index },
        });
      }

      return column;
    });
  }

  async findColumnById(columnId: string): Promise<KanbanColumn | null> {
    const column = await this.prisma.kanbanColumn.findUnique({
      where: { id: columnId },
      include: {
        _count: {
          select: { cards: true },
        },
      },
    });

    if (!column) return null;

    return {
      ...column,
      cardsCount: column._count.cards,
    };
  }

  /**
   * The board: its columns (paged, searched) and their cards.
   *
   * The cards of every listed column come in ONE query, grouped here. It
   * used to be one query per column in a Promise.all, which asked for as many
   * pool connections as the page had columns (table-infra §3 allows two per
   * list) and signed each card's avatar URL again.
   *
   * With a search, a column whose title matches shows all its cards; any
   * other column only the cards that match. A user without full Kanban read
   * sees only the columns holding their own cards, and only those cards.
   */
  async findColumnsByBusinessId(
    businessId: string,
    includeCards: boolean = false,
    page?: number,
    pageSize?: number,
    search?: string,
    filterByUserId?: string,
  ): Promise<ListKanbanColumnProps> {
    const skip = page && pageSize ? (page - 1) * pageSize : undefined;
    const take = pageSize || undefined;

    const normalizedSearch = search ? search.trim().toLowerCase() : "";

    const matchingPriorities = normalizedSearch
      ? getPrioritiesFromSearch(normalizedSearch)
      : [];

    // Handed to buildSearchOr below, which escapes the LIKE wildcards.
    const cardSearchConditions: Prisma.KanbanCardWhereInput[] = normalizedSearch
      ? [
          { id: { contains: normalizedSearch, mode: "insensitive" } },
          { title: { contains: normalizedSearch, mode: "insensitive" } },
          { description: { contains: normalizedSearch, mode: "insensitive" } },
          {
            assignedUser: {
              OR: [
                { name: { contains: normalizedSearch, mode: "insensitive" } },
                { email: { contains: normalizedSearch, mode: "insensitive" } },
              ],
            },
          },
          ...(matchingPriorities.length > 0
            ? [{ priority: { in: matchingPriorities } }]
            : []),
        ]
      : [];

    const searchConditions: any[] = [];

    if (normalizedSearch) {
      searchConditions.push({
        title: { contains: normalizedSearch, mode: "insensitive" },
      });

      if (includeCards) {
        searchConditions.push({
          cards: {
            some: {
              ...buildSearchOr(cardSearchConditions),
              ...(filterByUserId && { assignedUserId: filterByUserId }),
            },
          },
        });
      }
    }

    const whereCondition: any = {
      businessId,
      ...buildSearchOr(searchConditions),
    };

    // If there is a filter by user, ALWAYS filter only columns that have the user's cards.
    if (filterByUserId) {
      whereCondition.cards = {
        some: {
          assignedUserId: filterByUserId,
        },
      };
    }

    // Two queries at once at most: the page and its total.
    const [columns, total] = await Promise.all([
      this.prisma.kanbanColumn.findMany({
        skip,
        take,
        where: whereCondition,
        orderBy: { position: "asc" },
        include: {
          _count: {
            select: { cards: true },
          },
        },
      }),
      this.prisma.kanbanColumn.count({ where: whereCondition }),
    ]);

    if (!includeCards || columns.length === 0) {
      return {
        data: columns.map((column) => ({
          ...column,
          cardsCount: column._count.cards,
          ...(includeCards && { cards: [] }),
        })),
        total,
      };
    }

    // Columns found by their own title show every card (of this user, when
    // filtered); the rest only the matching ones.
    const directColumnIds = normalizedSearch
      ? columns
          .filter((column) => column.title.toLowerCase().includes(normalizedSearch))
          .map((column) => column.id)
      : [];

    const cardWhere: Prisma.KanbanCardWhereInput = {
      columnId: { in: columns.map((column) => column.id) },
      ...(filterByUserId && { assignedUserId: filterByUserId }),
      ...(normalizedSearch &&
        buildSearchOr([
          ...(directColumnIds.length > 0
            ? [{ columnId: { in: directColumnIds } }]
            : []),
          ...cardSearchConditions,
        ])),
    };

    const cards = await this.prisma.kanbanCard.findMany({
      where: cardWhere,
      orderBy: [{ position: "asc" }, { id: "asc" }],
      include: {
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });

    const sign = this.avatarSigner();
    const mapped = await Promise.all(cards.map((card) => this.mapCard(card, sign)));

    const byColumn = new Map<string, KanbanCard[]>();

    for (const card of mapped) {
      const list = byColumn.get(card.columnId) ?? [];
      list.push(card);
      byColumn.set(card.columnId, list);
    }

    return {
      data: columns.map((column) => ({
        ...column,
        cardsCount: column._count.cards,
        cards: byColumn.get(column.id) ?? [],
      })),
      total,
    };
  }

  async getNextColumnPosition(businessId: string): Promise<number> {
    const lastColumn = await this.prisma.kanbanColumn.findFirst({
      where: { businessId },
      orderBy: { position: "desc" },
    });

    return lastColumn ? lastColumn.position + 1 : 0;
  }

  async getFirstColumnByBusinessId(
    businessId: string,
  ): Promise<KanbanColumn | null> {
    const firstColumn = await this.prisma.kanbanColumn.findFirst({
      where: { businessId },
      orderBy: { position: "asc" },
    });

    return firstColumn;
  }

  async reorderColumns(data: ReorderKanbanColumnsProps): Promise<void> {
    await this.prisma
      .$transaction(async (tx) => {
        // Against a concurrent create/delete of a column on the same board.
        await this.lockBoard(tx, data.businessId);

        const tempUpdates = data.columns.map((column, index) =>
          tx.kanbanColumn.update({
            where: { id: column.id },
            data: { position: -(index + 1) },
          }),
        );

        await Promise.all(tempUpdates);

        const finalUpdates = data.columns.map((column) =>
          tx.kanbanColumn.update({
            where: { id: column.id },
            data: { position: column.position },
          }),
        );

        await Promise.all(finalUpdates);
      })
      .catch((error: unknown) => {
        // A column deleted between the use case's check and the lock.
        if (KanbanRepository.isMissingRow(error)) {
          throw new KanbanOneOrMoreColumnNotBelongBusinessError();
        }

        throw error;
      });
  }

  // `tx` lets callers create the card and its outbox event atomically.
  async createCard(
    cardData: CreateKanbanCardProps,
    tx?: Prisma.TransactionClient,
  ): Promise<KanbanCard> {
    if (!tx) {
      return this.prisma.$transaction((own) => this.createCard(cardData, own));
    }

    // The next position is read and written under the column's row lock:
    // read-then-insert outside it gave two cards created at once the same
    // position.
    const columnExists = await this.lockColumn(tx, cardData.columnId);

    if (!columnExists) {
      throw new KanbanColumnNotFoundError();
    }

    const last = await tx.kanbanCard.findFirst({
      where: { columnId: cardData.columnId },
      orderBy: { position: "desc" },
      select: { position: true },
    });

    const card = await tx.kanbanCard.create({
      data: {
        ...cardData,
        position: cardData.position ?? (last ? last.position + 1 : 0),
        dueDate: cardData.dueDate,
        completed: cardData.completed || false,
      },
      include: {
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });

    return this.mapCard(card);
  }

  async updateCard(
    { cardData, cardId }: UpdateKanbanCard,
    tx?: Prisma.TransactionClient,
  ): Promise<KanbanCard> {
    const client = tx ?? this.prisma;

    const filteredData = Object.fromEntries(
      Object.entries(cardData).filter(([_, value]) => value !== undefined),
    );

    if (filteredData.dueDate) {
      filteredData.dueDate = new Date(filteredData.dueDate as string);
    }

    // Specific treatment for the completed field
    if (filteredData.completed !== undefined) {
      filteredData.completed = Boolean(filteredData.completed);
    }

    const card = await client.kanbanCard
      .update({
        where: { id: cardId },
        data: filteredData,
        include: {
          assignedUser: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
            },
          },
        },
      })
      .catch((error: unknown) => {
        // Deleted between the use case's read and this write.
        if (KanbanRepository.isMissingRow(error)) throw new KanbanCardNotFoundError();

        throw error;
      });

    return this.mapCard(card);
  }

  /**
   * Runs a card write whose column locks were chosen from an unlocked read.
   *
   * Every writer that moves or removes a card holds the lock of the column
   * the card is in, so once a transaction holds that lock and re-reads the
   * card still there, the card cannot leave. When the re-read finds it moved
   * in between, `run` answers CARD_MOVED: the transaction ends (dropping its
   * locks, so no lock is ever taken out of order) and runs again.
   */
  private async withCardColumnsLocked<T>(
    run: (tx: Prisma.TransactionClient) => Promise<T | typeof CARD_MOVED>,
  ): Promise<T> {
    for (let attempt = 1; attempt <= CARD_MOVE_ATTEMPTS; attempt += 1) {
      const result = await this.prisma.$transaction(run);

      if (result !== CARD_MOVED) return result as T;
    }

    throw new KanbanBoardChangedError();
  }

  /**
   * Delete and compaction of the column's positions, one transaction, under
   * the lock of the column the card is in NOW. It used to lock the column
   * read before the lock: a card moved meanwhile was compacted in a column
   * this transaction did not hold, beside a concurrent create there.
   */
  async deleteCard(cardId: string): Promise<KanbanCard> {
    const card = await this.withCardColumnsLocked(async (tx) => {
      const before = await tx.kanbanCard.findUnique({
        where: { id: cardId },
        select: { columnId: true },
      });

      // A column deleted meanwhile took its cards with it (ON DELETE CASCADE).
      if (!before || !(await this.lockColumn(tx, before.columnId))) {
        throw new KanbanCardNotFoundError();
      }

      const now = await tx.kanbanCard.findUnique({
        where: { id: cardId },
        select: { columnId: true },
      });

      if (!now) throw new KanbanCardNotFoundError();

      if (now.columnId !== before.columnId) return CARD_MOVED;

      const deleted = await tx.kanbanCard.delete({
        where: { id: cardId },
        include: {
          assignedUser: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
            },
          },
        },
      });

      const remaining = await tx.kanbanCard.findMany({
        where: { columnId: deleted.columnId },
        orderBy: [{ position: "asc" }, { created_at: "asc" }, { id: "asc" }],
        select: { id: true, position: true },
      });

      for (const [index, c] of remaining.entries()) {
        if (c.position === index) continue;

        await tx.kanbanCard.update({
          where: { id: c.id },
          data: { position: index },
        });
      }

      return deleted;
    });

    return this.mapCard(card);
  }

  async findCardById(cardId: string): Promise<KanbanCard | null> {
    const card = await this.prisma.kanbanCard.findUnique({
      where: { id: cardId },
      include: {
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });

    if (!card) return null;
    return this.mapCard(card);
  }

  async findCardsByColumnId(columnId: string): Promise<KanbanCard[]> {
    const cards = await this.prisma.kanbanCard.findMany({
      where: { columnId },
      orderBy: { position: "asc" },
      include: {
        assignedUser: {
          select: {
            id: true,
            name: true,
            email: true,
            avatar: true,
          },
        },
      },
    });

    const sign = this.avatarSigner();

    return Promise.all(cards.map((card) => this.mapCard(card, sign)));
  }

  async getNextCardPosition(columnId: string): Promise<number> {
    const lastCard = await this.prisma.kanbanCard.findFirst({
      where: { columnId },
      orderBy: { position: "desc" },
    });

    return lastCard ? lastCard.position + 1 : 0;
  }

  /**
   * Locks every column the move touches — where the cards ARE and where they
   * go — in one order (by id), so two reorders cannot deadlock, and answers
   * CARD_MOVED when a card left its column before the locks were held.
   * Locking only the targets let a delete compact a source column while its
   * cards were leaving it.
   */
  private async lockColumnsOfMove(
    tx: Prisma.TransactionClient,
    moves: Array<{ id: string; columnId: string }>,
  ): Promise<typeof CARD_MOVED | null> {
    const cardIds = Array.from(new Set(moves.map((move) => move.id)));

    const before = await tx.kanbanCard.findMany({
      where: { id: { in: cardIds } },
      select: { id: true, columnId: true },
    });

    if (before.length !== cardIds.length) throw new KanbanCardNotFoundError();

    const targets = new Set(moves.map((move) => move.columnId));
    const columnIds = Array.from(
      new Set([...before.map((card) => card.columnId), ...targets]),
    ).sort();

    for (const columnId of columnIds) {
      if (!(await this.lockColumn(tx, columnId))) {
        // A target gone is a missing column; a source gone took its cards.
        throw targets.has(columnId)
          ? new KanbanColumnNotFoundError()
          : new KanbanCardNotFoundError();
      }
    }

    const source = new Map(before.map((card) => [card.id, card.columnId]));

    const now = await tx.kanbanCard.findMany({
      where: { id: { in: cardIds } },
      select: { id: true, columnId: true },
    });

    if (now.length !== cardIds.length) throw new KanbanCardNotFoundError();

    return now.some((card) => source.get(card.id) !== card.columnId)
      ? CARD_MOVED
      : null;
  }

  async reorderCards(data: ReorderKanbanCardsProps): Promise<void> {
    await this.withCardColumnsLocked(async (tx) => {
      if ((await this.lockColumnsOfMove(tx, data.cards)) === CARD_MOVED) {
        return CARD_MOVED;
      }

      const cardsByColumn = data.cards.reduce(
        (acc, card) => {
          if (!acc[card.columnId]) {
            acc[card.columnId] = [];
          }
          acc[card.columnId].push(card);
          return acc;
        },
        {} as Record<string, typeof data.cards>,
      );

      for (const cards of Object.values(cardsByColumn)) {
        const tempUpdates = cards.map((card, index) =>
          tx.kanbanCard.update({
            where: { id: card.id },
            data: {
              position: -(index + 1000),
              columnId: card.columnId,
            },
          }),
        );

        await Promise.all(tempUpdates);

        const finalUpdates = cards.map((card) =>
          tx.kanbanCard.update({
            where: { id: card.id },
            data: {
              position: card.position,
              columnId: card.columnId,
            },
          }),
        );

        await Promise.all(finalUpdates);
      }

      return true;
    });
  }

  async moveCardToColumn(data: MoveCardToColumnProps): Promise<KanbanCard> {
    const card = await this.withCardColumnsLocked(async (tx) => {
      const move = { id: data.cardId, columnId: data.targetColumnId };

      if ((await this.lockColumnsOfMove(tx, [move])) === CARD_MOVED) {
        return CARD_MOVED;
      }

      return tx.kanbanCard.update({
        where: { id: data.cardId },
        data: {
          columnId: data.targetColumnId,
          position: data.position,
        },
        include: {
          assignedUser: {
            select: {
              id: true,
              name: true,
              email: true,
              avatar: true,
            },
          },
        },
      });
    });

    return this.mapCard(card);
  }
}

export { KanbanRepository };
