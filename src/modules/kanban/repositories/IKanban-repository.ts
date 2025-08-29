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

interface IKanbanRepository {
  // Column methods
  createColumn: (columnData: CreateKanbanColumnProps) => Promise<KanbanColumn>;
  updateColumn: ({
    columnData,
    columnId,
  }: UpdateKanbanColumn) => Promise<KanbanColumn>;
  deleteColumn: (columnId: string) => Promise<KanbanColumn>;
  findColumnById: (columnId: string) => Promise<KanbanColumn | null>;
  findColumnsByBusinessId: (
    businessId: string,
    includeCards?: boolean,
    page?: number,
    pageSize?: number,
    search?: string,
    filterByUserId?: string,
  ) => Promise<ListKanbanColumnProps>;
  getNextColumnPosition: (businessId: string) => Promise<number>;
  reorderColumns: (data: ReorderKanbanColumnsProps) => Promise<void>;
  getFirstColumnByBusinessId: (
    businessId: string,
  ) => Promise<KanbanColumn | null>;

  // Card methods
  createCard: (cardData: CreateKanbanCardProps) => Promise<KanbanCard>;
  updateCard: ({ cardData, cardId }: UpdateKanbanCard) => Promise<KanbanCard>;
  deleteCard: (cardId: string) => Promise<KanbanCard>;
  findCardById: (cardId: string) => Promise<KanbanCard | null>;
  findCardsByColumnId: (columnId: string) => Promise<KanbanCard[]>;
  getNextCardPosition: (columnId: string) => Promise<number>;
  reorderCards: (data: ReorderKanbanCardsProps) => Promise<void>;
  moveCardToColumn: (data: MoveCardToColumnProps) => Promise<KanbanCard>;
}

export { IKanbanRepository };
