interface KanbanColumn {
  id: string;
  title: string;
  color: string;
  position: number;
  businessId: string;
  cardsCount?: number;
  cards?: KanbanCard[];
  created_at: Date | string;
  updated_at: Date | string;
}

interface CreateKanbanColumnProps {
  title: string;
  color: string;
  position?: number;
  businessId: string;
}

interface UpdateKanbanColumnProps {
  title?: string;
  color?: string;
  position?: number;
}

interface UpdateKanbanColumn {
  columnData: UpdateKanbanColumnProps;
  columnId: string;
}

interface ReorderKanbanColumnsProps {
  columns: Array<{
    id: string;
    position: number;
  }>;
  businessId: string;
}

interface KanbanCard {
  id: string;
  title: string;
  description: string;
  priority: string;
  dueDate: string;
  position: number;
  columnId: string;
  assignedUserId?: string | null;
  completed?: boolean;
  assignedUser: {
    id: string;
    name: string;
    email: string;
    avatar: string | null;
  } | null;
  created_at: string;
  updated_at: string;
}

interface CreateKanbanCardProps {
  title: string;
  description: string;
  priority: string;
  dueDate: Date | string;
  position?: number;
  columnId: string;
  assignedUserId?: string | null;
  completed?: boolean;
}

interface UpdateKanbanCardProps {
  title?: string;
  description?: string;
  priority?: string;
  dueDate?: Date | string;
  position?: number;
  columnId?: string;
  assignedUserId?: string | null;
  completed?: boolean;
}

interface UpdateKanbanCard {
  cardData: UpdateKanbanCardProps;
  cardId: string;
}

interface ReorderKanbanCardsProps {
  cards: Array<{
    id: string;
    position: number;
    columnId: string;
  }>;
}

interface MoveCardToColumnProps {
  cardId: string;
  targetColumnId: string;
  position: number;
}

interface ListKanbanByBusinessProps {
  businessId: string;
  includeCards?: boolean;
}

interface ListKanbanColumnProps {
  data: KanbanColumn[];
  total: number;
}

export {
  KanbanColumn,
  CreateKanbanColumnProps,
  UpdateKanbanColumnProps,
  UpdateKanbanColumn,
  ReorderKanbanColumnsProps,
  KanbanCard,
  CreateKanbanCardProps,
  UpdateKanbanCardProps,
  UpdateKanbanCard,
  ReorderKanbanCardsProps,
  MoveCardToColumnProps,
  ListKanbanByBusinessProps,
  ListKanbanColumnProps,
};
