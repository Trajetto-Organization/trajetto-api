import { v7 as uuidV7 } from "uuid";

import { IKanbanRepository } from "../IKanban-repository";

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
} from "../../dtos/kanban-dto";

import { KanbanColumnNotFoundError } from "../../usecases/errors/kanban-column-not-found-error";
import { KanbanCardNotFoundError } from "../../usecases/errors/kanban-card-not-found-error";
import { KanbanOneOrMoreColumnNotBelongBusinessError } from "../../usecases/errors/kanban-one-or-more-column-not-belong-business-error";

/** Portuguese priority words the board search understands, as the repository maps them. */
const PRIORITY_MAPPING: Record<string, string> = {
  baixa: "low",
  média: "medium",
  media: "medium",
  alta: "high",
  urgente: "urgent",
};

function prioritiesFromSearch(term: string): string[] {
  const normalized = term.toLowerCase().trim();

  if (PRIORITY_MAPPING[normalized]) return [PRIORITY_MAPPING[normalized]];

  for (const [word, priority] of Object.entries(PRIORITY_MAPPING)) {
    if (word.includes(normalized) || normalized.includes(word)) return [priority];
  }

  return [];
}

const contains = (value: string | null | undefined, term: string) =>
  (value ?? "").toLowerCase().includes(term.toLowerCase());

interface StoredColumn {
  id: string;
  title: string;
  color: string;
  position: number;
  businessId: string;
  created_at: Date;
  updated_at: Date;
}

interface StoredCard {
  id: string;
  title: string;
  description: string;
  priority: string;
  dueDate: Date;
  position: number;
  columnId: string;
  assignedUserId: string | null;
  completed: boolean;
  created_at: Date;
  updated_at: Date;
}

interface AssignableUser {
  id: string;
  name: string;
  email: string;
  avatar: string | null;
}

/**
 * The board in memory, answering as KanbanRepository does (decision 13.2):
 * positions appended at the end of the board / column, gaps closed after a
 * delete, the ON DELETE CASCADE of a column's cards, the list's search and
 * per-user filter, and the repository's not-found errors for a missing row
 * (it maps Prisma's P2025 to them), with no partial write on a refusal.
 */
class InMemoryKanbanRepository implements IKanbanRepository {
  public columns: StoredColumn[] = [];

  public cards: StoredCard[] = [];

  /** The user table, for the `assignedUser` join. */
  public users = new Map<string, AssignableUser>();

  private toCard(card: StoredCard): KanbanCard {
    const user = card.assignedUserId ? this.users.get(card.assignedUserId) : undefined;

    return {
      ...card,
      dueDate: card.dueDate as unknown as string,
      created_at: card.created_at as unknown as string,
      updated_at: card.updated_at as unknown as string,
      assignedUser: user ? { ...user } : null,
    };
  }

  private cardsOf(columnId: string): StoredCard[] {
    return this.cards
      .filter((card) => card.columnId === columnId)
      .sort((a, b) => a.position - b.position);
  }

  private compact<T extends { position: number; created_at: Date; id: string }>(rows: T[]): void {
    rows
      .sort(
        (a, b) =>
          a.position - b.position ||
          a.created_at.getTime() - b.created_at.getTime() ||
          (a.id < b.id ? -1 : 1),
      )
      .forEach((row, index) => {
        row.position = index;
      });
  }

  async createColumn(columnData: CreateKanbanColumnProps): Promise<KanbanColumn> {
    const column: StoredColumn = {
      id: uuidV7(),
      title: columnData.title,
      color: columnData.color,
      businessId: columnData.businessId,
      position:
        columnData.position ?? (await this.getNextColumnPosition(columnData.businessId)),
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.columns.push(column);

    return { ...column };
  }

  async updateColumn({ columnData, columnId }: UpdateKanbanColumn): Promise<KanbanColumn> {
    const column = this.columns.find((item) => item.id === columnId);

    if (!column) throw new KanbanColumnNotFoundError();

    for (const [key, value] of Object.entries(columnData)) {
      if (value !== undefined) (column as unknown as Record<string, unknown>)[key] = value;
    }

    column.updated_at = new Date();

    return { ...column };
  }

  async deleteColumn(columnId: string): Promise<KanbanColumn> {
    const index = this.columns.findIndex((item) => item.id === columnId);

    if (index === -1) throw new KanbanColumnNotFoundError();

    const [column] = this.columns.splice(index, 1);

    // ON DELETE CASCADE.
    this.cards = this.cards.filter((card) => card.columnId !== columnId);

    this.compact(this.columns.filter((item) => item.businessId === column.businessId));

    return { ...column };
  }

  async findColumnById(columnId: string): Promise<KanbanColumn | null> {
    const column = this.columns.find((item) => item.id === columnId);

    if (!column) return null;

    return { ...column, cardsCount: this.cardsOf(column.id).length };
  }

  async findColumnsByBusinessId(
    businessId: string,
    includeCards = false,
    page?: number,
    pageSize?: number,
    search?: string,
    filterByUserId?: string,
  ): Promise<ListKanbanColumnProps> {
    const term = search?.trim().toLowerCase() ?? "";
    const priorities = term ? prioritiesFromSearch(term) : [];

    const cardMatches = (card: StoredCard): boolean => {
      const user = card.assignedUserId ? this.users.get(card.assignedUserId) : undefined;

      return (
        contains(card.id, term) ||
        contains(card.title, term) ||
        contains(card.description, term) ||
        contains(user?.name, term) ||
        contains(user?.email, term) ||
        priorities.includes(card.priority)
      );
    };

    let columns = this.columns
      .filter((column) => column.businessId === businessId)
      .sort((a, b) => a.position - b.position);

    if (term) {
      columns = columns.filter(
        (column) =>
          contains(column.title, term) ||
          (includeCards &&
            this.cardsOf(column.id).some(
              (card) =>
                cardMatches(card) &&
                (!filterByUserId || card.assignedUserId === filterByUserId),
            )),
      );
    }

    if (filterByUserId) {
      columns = columns.filter((column) =>
        this.cardsOf(column.id).some((card) => card.assignedUserId === filterByUserId),
      );
    }

    const total = columns.length;

    if (page && pageSize) {
      columns = columns.slice((page - 1) * pageSize, page * pageSize);
    } else if (pageSize) {
      columns = columns.slice(0, pageSize);
    }

    const data = columns.map((column) => {
      const all = this.cardsOf(column.id);
      const base = { ...column, cardsCount: all.length };

      if (!includeCards) return base;

      const columnMatches = term !== "" && contains(column.title, term);

      const shown = all.filter((card) => {
        if (filterByUserId && card.assignedUserId !== filterByUserId) return false;
        if (!term || columnMatches) return true;

        return cardMatches(card);
      });

      return { ...base, cards: shown.map((card) => this.toCard(card)) };
    });

    return { data, total };
  }

  async getNextColumnPosition(businessId: string): Promise<number> {
    const positions = this.columns
      .filter((column) => column.businessId === businessId)
      .map((column) => column.position);

    return positions.length > 0 ? Math.max(...positions) + 1 : 0;
  }

  async reorderColumns(data: ReorderKanbanColumnsProps): Promise<void> {
    const found = data.columns.map(({ id }) => this.columns.find((item) => item.id === id));

    // One transaction there: a missing column changes nothing.
    if (found.some((column) => !column)) {
      throw new KanbanOneOrMoreColumnNotBelongBusinessError();
    }

    data.columns.forEach(({ position }, index) => {
      (found[index] as StoredColumn).position = position;
    });
  }

  async getFirstColumnByBusinessId(businessId: string): Promise<KanbanColumn | null> {
    const [first] = this.columns
      .filter((column) => column.businessId === businessId)
      .sort((a, b) => a.position - b.position);

    return first ? { ...first } : null;
  }

  async createCard(cardData: CreateKanbanCardProps, _tx?: unknown): Promise<KanbanCard> {
    if (!this.columns.some((column) => column.id === cardData.columnId)) {
      throw new KanbanColumnNotFoundError();
    }

    const card: StoredCard = {
      id: uuidV7(),
      title: cardData.title,
      description: cardData.description,
      priority: cardData.priority,
      dueDate: new Date(cardData.dueDate),
      columnId: cardData.columnId,
      assignedUserId: cardData.assignedUserId ?? null,
      completed: cardData.completed || false,
      position: cardData.position ?? (await this.getNextCardPosition(cardData.columnId)),
      created_at: new Date(),
      updated_at: new Date(),
    };

    this.cards.push(card);

    return this.toCard(card);
  }

  async updateCard({ cardData, cardId }: UpdateKanbanCard, _tx?: unknown): Promise<KanbanCard> {
    const card = this.cards.find((item) => item.id === cardId);

    if (!card) throw new KanbanCardNotFoundError();

    for (const [key, value] of Object.entries(cardData)) {
      if (value === undefined) continue;

      if (key === "dueDate") card.dueDate = new Date(value as string);
      else if (key === "completed") card.completed = Boolean(value);
      else (card as unknown as Record<string, unknown>)[key] = value;
    }

    card.updated_at = new Date();

    return this.toCard(card);
  }

  async deleteCard(cardId: string): Promise<KanbanCard> {
    const index = this.cards.findIndex((item) => item.id === cardId);

    if (index === -1) throw new KanbanCardNotFoundError();

    const [card] = this.cards.splice(index, 1);

    this.compact(this.cards.filter((item) => item.columnId === card.columnId));

    return this.toCard(card);
  }

  async findCardById(cardId: string): Promise<KanbanCard | null> {
    const card = this.cards.find((item) => item.id === cardId);

    return card ? this.toCard(card) : null;
  }

  async findCardsByColumnId(columnId: string): Promise<KanbanCard[]> {
    return this.cardsOf(columnId).map((card) => this.toCard(card));
  }

  async getNextCardPosition(columnId: string): Promise<number> {
    const positions = this.cards
      .filter((card) => card.columnId === columnId)
      .map((card) => card.position);

    return positions.length > 0 ? Math.max(...positions) + 1 : 0;
  }

  /** Every card and target column of a move, or the repository's refusal. */
  private resolveMove(moves: Array<{ id: string; columnId: string }>): StoredCard[] {
    const cards = moves.map(({ id }) => this.cards.find((item) => item.id === id));

    if (cards.some((card) => !card)) throw new KanbanCardNotFoundError();

    for (const { columnId } of moves) {
      if (!this.columns.some((column) => column.id === columnId)) {
        throw new KanbanColumnNotFoundError();
      }
    }

    return cards as StoredCard[];
  }

  async reorderCards(data: ReorderKanbanCardsProps): Promise<void> {
    // Checked before any write, as the repository's transaction rolls back.
    const cards = this.resolveMove(data.cards);

    data.cards.forEach(({ position, columnId }, index) => {
      cards[index].position = position;
      cards[index].columnId = columnId;
    });
  }

  async moveCardToColumn(data: MoveCardToColumnProps): Promise<KanbanCard> {
    const [card] = this.resolveMove([{ id: data.cardId, columnId: data.targetColumnId }]);

    card.columnId = data.targetColumnId;
    card.position = data.position;

    return this.toCard(card);
  }
}

export { InMemoryKanbanRepository };
