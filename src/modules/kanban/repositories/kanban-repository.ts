import database from "@/../infra/database";
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

  // Assincrono porque `getFileUrl` assina a URL do R2 (AWS SDK v3). Atencao:
  // `card` e `any`, entao o TypeScript NAO acusaria se o await ficasse de fora
  // e o avatar viraria uma Promise serializada como {} no JSON.
  private mapCard = async (card: any): Promise<KanbanCard> => {
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
              ? await this.uploadService.getFileUrl(card.assignedUser.avatar)
              : null,
          }
        : null,
    };
  };

  async createColumn(
    columnData: CreateKanbanColumnProps,
  ): Promise<KanbanColumn> {
    const position =
      columnData.position ??
      (await this.getNextColumnPosition(columnData.businessId));

    const column = await this.prisma.kanbanColumn.create({
      data: {
        ...columnData,
        position,
      },
    });

    return column;
  }

  async updateColumn({
    columnData,
    columnId,
  }: UpdateKanbanColumn): Promise<KanbanColumn> {
    const filteredData = Object.fromEntries(
      Object.entries(columnData).filter(([_, value]) => value !== undefined),
    );

    const column = await this.prisma.kanbanColumn.update({
      where: { id: columnId },
      data: filteredData,
    });

    return column;
  }

  async deleteColumn(columnId: string): Promise<KanbanColumn> {
    const column = await this.prisma.kanbanColumn.delete({
      where: { id: columnId },
    });

    // Reorder remaining columns
    const remainingColumns = await this.prisma.kanbanColumn.findMany({
      where: { businessId: column.businessId },
      orderBy: { position: "asc" },
    });

    await this.prisma.$transaction(
      remainingColumns.map((col, index) =>
        this.prisma.kanbanColumn.update({
          where: { id: col.id },
          data: { position: index },
        }),
      ),
    );

    return column;
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

    const searchConditions: any[] = [];

    if (search) {
      const normalizedSearch = search.trim().toLowerCase();

      // Search for priorities matching the search term
      const matchingPriorities = getPrioritiesFromSearch(normalizedSearch);

      searchConditions.push({
        title: {
          contains: normalizedSearch,
          mode: "insensitive",
        },
      });

      if (includeCards) {
        // Search conditions for cards
        const cardSearchConditions: any[] = [
          {
            id: {
              contains: normalizedSearch,
              mode: "insensitive",
            },
          },
          {
            title: {
              contains: normalizedSearch,
              mode: "insensitive",
            },
          },
          {
            description: {
              contains: normalizedSearch,
              mode: "insensitive",
            },
          },
          {
            assignedUser: {
              OR: [
                {
                  name: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
                {
                  email: {
                    contains: normalizedSearch,
                    mode: "insensitive",
                  },
                },
              ],
            },
          },
        ];

        // Add priority search if matches found
        if (matchingPriorities.length > 0) {
          cardSearchConditions.push({
            priority: {
              in: matchingPriorities,
            },
          });
        }

        const cardBaseCondition: any = {
          some: {
            OR: cardSearchConditions,
          },
        };

        // If there is a filter by user, add this condition to the card search.
        if (filterByUserId) {
          cardBaseCondition.some.assignedUserId = filterByUserId;
        }

        searchConditions.push({
          cards: cardBaseCondition,
        });
      }
    }

    const whereCondition: any = {
      businessId,
      ...(searchConditions.length > 0 && { OR: searchConditions }),
    };

    // If there is a filter by user, ALWAYS filter only columns that have the user's cards.
    if (filterByUserId) {
      whereCondition.cards = {
        some: {
          assignedUserId: filterByUserId,
        },
      };
    }

    const columns = await this.prisma.kanbanColumn.findMany({
      skip,
      take,
      where: whereCondition,
      orderBy: { position: "asc" },
      include: {
        _count: {
          select: { cards: true },
        },
      },
    });

    const columnsWithCards = await Promise.all(
      columns.map(async (column) => {
        if (!includeCards) {
          return {
            ...column,
            cardsCount: column._count.cards,
          };
        }

        let cardsToShow;

        if (search) {
          const normalizedSearch = search.trim().toLowerCase();
          const matchingPriorities = getPrioritiesFromSearch(normalizedSearch);

          const columnMatchesDirectly = column.title
            .toLowerCase()
            .includes(normalizedSearch);

          if (columnMatchesDirectly && !filterByUserId) {
            // If you search by column and there is no user filter, it shows all the cards.
            cardsToShow = await this.prisma.kanbanCard.findMany({
              where: { columnId: column.id },
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
          } else if (columnMatchesDirectly && filterByUserId) {
            // If you search by column but there is a user filter, it only shows cards assigned to the user.
            cardsToShow = await this.prisma.kanbanCard.findMany({
              where: {
                columnId: column.id,
                assignedUserId: filterByUserId,
              },
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
          } else {
            // Specific search for cards
            const cardWhereConditions: any[] = [
              {
                id: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                title: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                description: {
                  contains: normalizedSearch,
                  mode: "insensitive",
                },
              },
              {
                assignedUser: {
                  OR: [
                    {
                      name: {
                        contains: normalizedSearch,
                        mode: "insensitive",
                      },
                    },
                    {
                      email: {
                        contains: normalizedSearch,
                        mode: "insensitive",
                      },
                    },
                  ],
                },
              },
            ];

            // Add priority search
            if (matchingPriorities.length > 0) {
              cardWhereConditions.push({
                priority: {
                  in: matchingPriorities,
                },
              });
            }

            const cardWhereBase: any = {
              columnId: column.id,
              OR: cardWhereConditions,
            };

            // If there is a filter by user, add this condition.
            if (filterByUserId) {
              cardWhereBase.assignedUserId = filterByUserId;
            }

            cardsToShow = await this.prisma.kanbanCard.findMany({
              where: cardWhereBase,
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
          }
        } else {
          // No search - normal behavior
          const cardWhereBase: any = { columnId: column.id };

          // If there is a filter by user, add this condition.
          if (filterByUserId) {
            cardWhereBase.assignedUserId = filterByUserId;
          }

          cardsToShow = await this.prisma.kanbanCard.findMany({
            where: cardWhereBase,
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
        }

        return {
          ...column,
          cardsCount: column._count.cards,
          cards: await Promise.all(cardsToShow.map(this.mapCard)),
        };
      }),
    );

    const total = await this.prisma.kanbanColumn.count({
      where: whereCondition,
    });

    return {
      data: columnsWithCards,
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
    await this.prisma.$transaction(async (tx) => {
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
    });
  }

  async createCard(cardData: CreateKanbanCardProps): Promise<KanbanCard> {
    const position =
      cardData.position ?? (await this.getNextCardPosition(cardData.columnId));

    const card = await this.prisma.kanbanCard.create({
      data: {
        ...cardData,
        position,
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

  async updateCard({
    cardData,
    cardId,
  }: UpdateKanbanCard): Promise<KanbanCard> {
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

    const card = await this.prisma.kanbanCard.update({
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
    });

    return this.mapCard(card);
  }

  async deleteCard(cardId: string): Promise<KanbanCard> {
    const card = await this.prisma.kanbanCard.delete({
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

    // Reorder remaining cards in the column
    const remainingCards = await this.prisma.kanbanCard.findMany({
      where: { columnId: card.columnId },
      orderBy: { position: "asc" },
    });

    await this.prisma.$transaction(
      remainingCards.map((c, index) =>
        this.prisma.kanbanCard.update({
          where: { id: c.id },
          data: { position: index },
        }),
      ),
    );

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

    return Promise.all(cards.map(this.mapCard));
  }

  async getNextCardPosition(columnId: string): Promise<number> {
    const lastCard = await this.prisma.kanbanCard.findFirst({
      where: { columnId },
      orderBy: { position: "desc" },
    });

    return lastCard ? lastCard.position + 1 : 0;
  }

  async reorderCards(data: ReorderKanbanCardsProps): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
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

      for (const [columnId, cards] of Object.entries(cardsByColumn)) {
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
    });
  }

  async moveCardToColumn(data: MoveCardToColumnProps): Promise<KanbanCard> {
    const card = await this.prisma.kanbanCard.update({
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

    return this.mapCard(card);
  }
}

export { KanbanRepository };
