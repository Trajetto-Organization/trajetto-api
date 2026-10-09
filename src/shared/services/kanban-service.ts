import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { IUserRepository } from "@/modules/user/repositories/IUser-repository";

import { OutboxService } from "@/shared/notifications/outbox-service";
import { formatCurrency } from "@/shared/utils/format-values";
import { logger } from "@/shared/logging/logger";
import {
  businessDayStart,
  resolveTimeZone,
  shiftDateKey,
} from "@/shared/time/business-day";
import { pickedDayKey } from "@/shared/vehicle/record-dates";

import database from "@/../infra/database";

/**
 * The shared logger (OBS-14). The step-by-step narration is debug, and no
 * line carries a card's contents: they used to be dumped whole on every card.
 */
const log = logger.child({ component: "kanban" });

interface CreateCardFromServiceOrderProps {
  serviceOrderId: string;
  vehicleLicensePlate: string;
  totalAmount: number;
  maintenanceType: "INTERNAL" | "EXTERNAL";
  orderDate: Date | string;
  completionDate?: Date | string | null;
  responsibleUserId?: string;
  businessId: string;
  createdByUserId: string;
  /** The company's zone (Business.timezone); the default when absent. */
  timeZone?: string | null;
}

/** How long a service order's automatic card has, in the company's days. */
const SERVICE_ORDER_CARD_DAYS = 7;

/**
 * The due date of a service order's card: the start, in the company's zone,
 * of the day seven days after the order's day (decision 1.2).
 *
 * The order's day follows the fleet records' rule (pickedDayKey): a bare
 * "YYYY-MM-DD" (00:00 UTC) is that day, anything else is read in the company's
 * zone. `setDate(getDate() + 7)` counted on the process's calendar instead,
 * which put a date-only order on the evening before. The company's midnight is
 * what a card whose date was picked on the web carries.
 */
function serviceOrderCardDueDate(orderDate: Date | string, timeZone: string): Date {
  const orderDay = pickedDayKey(new Date(orderDate), timeZone);

  return businessDayStart(shiftDateKey(orderDay, SERVICE_ORDER_CARD_DAYS), timeZone);
}

interface CreateCardFromEntityProps {
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "urgent";
  dueDate: Date;
  businessId: string;
  assignedUserId?: string;
  completed?: boolean;
  entityType?: string;
  entityId?: string;
}

@injectable()
class KanbanService {
  constructor(
    @inject("KanbanRepository")
    private kanban: IKanbanRepository,
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("OutboxService")
    private outbox: OutboxService,
  ) {}

  private async createDefaultKanbanColumns(businessId: string): Promise<void> {
    const defaultColumns = [
      {
        title: "Pendente",
        color: "#ef4444", // Red
        businessId,
      },
      {
        title: "Em Andamento",
        color: "#f97316", // Orange
        businessId,
      },
      {
        title: "Aguardando Peças",
        color: "#eab308", // Yellow
        businessId,
      },
      {
        title: "Concluído",
        color: "#22c55e", // Green
        businessId,
      },
    ];

    try {
      // Create columns sequentially to ensure correct positions
      for (let i = 0; i < defaultColumns.length; i++) {
        await this.kanban.createColumn({
          ...defaultColumns[i],
          position: i,
        });
      }

      log.info(
        { businessId, columns: defaultColumns.length },
        "default kanban columns created",
      );
    } catch (error) {
      log.error(
        { err: error, businessId },
        "default kanban columns could not be created",
      );

      throw error;
    }
  }

  private async getOrCreateKanbanColumns(
    businessId: string,
    completionDate?: Date | string,
  ): Promise<any> {
    try {
      // First, check if columns already exist
      const columns = await this.kanban.findColumnsByBusinessId(
        businessId,
        false,
      );

      if (columns.data.length === 0) {
        // If there are no columns, create the default ones
        await this.createDefaultKanbanColumns(businessId);

        // Refetch columns after creation
        const newColumns = await this.kanban.findColumnsByBusinessId(
          businessId,
          false,
        );

        if (newColumns.data.length === 0) {
          log.error({ businessId }, "kanban columns missing right after creation");
          return null;
        }
      }

      // Determine the correct column based on status
      const allColumns = await this.kanban.findColumnsByBusinessId(
        businessId,
        false,
      );

      if (completionDate) {
        // If it is already completed, look for the "Completed" column
        const completedColumn = allColumns.data.find(
          (col) =>
            col.title.toLowerCase().includes("concluído") ||
            col.title.toLowerCase().includes("concluido") ||
            col.title.toLowerCase().includes("finalizado"),
        );

        if (completedColumn) {
          log.debug(
            { businessId, columnId: completedColumn.id },
            "completed item goes to the done column",
          );
          return completedColumn;
        }
      }

      // For pending items, use the first column (Pending)
      const pendingColumn =
        allColumns.data.find(
          (col) =>
            col.title.toLowerCase().includes("pendente") ||
            col.title.toLowerCase().includes("novo") ||
            col.position === 0,
        ) || allColumns.data[0]; // Fallback to first column

      log.debug(
        { businessId, columnId: pendingColumn.id },
        "pending item goes to the first column",
      );
      return pendingColumn;
    } catch (error) {
      log.error(
        { err: error, businessId },
        "kanban columns could not be read or created",
      );
      return null;
    }
  }

  private calculatePriorityFromAmount(
    amount: number,
  ): "low" | "medium" | "high" | "urgent" {
    if (amount > 10000) {
      return "urgent";
    } else if (amount > 5000) {
      return "high";
    } else if (amount > 2000) {
      return "medium";
    }
    return "low";
  }

  async createCardFromServiceOrder(
    data: CreateCardFromServiceOrderProps,
  ): Promise<void> {
    try {
      // Search or create kanban columns for this company
      const targetColumn = await this.getOrCreateKanbanColumns(
        data.businessId,
        data.completionDate || undefined,
      );

      if (!targetColumn) {
        log.error(
          { businessId: data.businessId, serviceOrderId: data.serviceOrderId },
          "no kanban column for the service order's card",
        );
        return;
      }

      const timeZone = resolveTimeZone(data.timeZone);
      const dueDate = serviceOrderCardDueDate(data.orderDate, timeZone);

      // Determine priority based on value
      const priority = this.calculatePriorityFromAmount(data.totalAmount);

      // Create card description
      const description = [
        `Veículo: ${data.vehicleLicensePlate || "N/A"}`,
        `Valor: ${formatCurrency(data.totalAmount)}`,
        `Responsável: ${data.responsibleUserId ? "Atribuído" : "Não atribuído"}`,
        `Tipo: ${data.maintenanceType === "INTERNAL" ? "Interno" : "Externo"}`,
      ]
        .filter(Boolean)
        .join("\n");

      const cardData = {
        title: `Manutenção ${data.vehicleLicensePlate || data.serviceOrderId}`,
        description,
        priority,
        dueDate: dueDate,
        columnId: targetColumn.id,
        assignedUserId: data.responsibleUserId || data.createdByUserId,
        completed: !!data.completionDate,
      };

      // Notifying the creator about their own automatic card is noise, and
      // the old flow recorded nothing in that case either — preserved here by
      // simply not publishing an event.
      const assignedUserId = data.responsibleUserId || data.createdByUserId;
      const shouldPublish = assignedUserId !== data.createdByUserId;

      const createdCard = await database.$transaction(async (tx) => {
        const created = await this.kanban.createCard(cardData, tx);

        if (shouldPublish) {
          await this.outbox.publish(tx, {
            topic: "kanban-card.created",
            aggregateType: "kanban-card",
            aggregateId: created.id,
            businessId: data.businessId,
            actorId: data.createdByUserId,
            payload: {
              cardId: created.id,
              businessId: data.businessId,
              title: cardData.title,
              description: cardData.description || null,
              priority: cardData.priority,
              dueDate: cardData.dueDate.toISOString(),
              timeZone,
              isCompleted: cardData.completed,
              assignedUserId,
              fromServiceOrder: true,
            },
          });
        }

        return created;
      });

      log.debug(
        {
          businessId: data.businessId,
          serviceOrderId: data.serviceOrderId,
          cardId: createdCard.id,
        },
        "kanban card created for a service order",
      );
    } catch (error) {
      log.error(
        {
          err: error,
          businessId: data.businessId,
          serviceOrderId: data.serviceOrderId,
        },
        "kanban card for a service order could not be created",
      );
      // Does not impede the main flow
    }
  }

  async createCardFromEntity(data: CreateCardFromEntityProps): Promise<void> {
    try {
      // Search or create kanban columns for this company
      const targetColumn = await this.getOrCreateKanbanColumns(
        data.businessId,
        data.completed ? new Date() : undefined,
      );

      if (!targetColumn) {
        log.error(
          {
            businessId: data.businessId,
            entityType: data.entityType,
            entityId: data.entityId,
          },
          "no kanban column for the card",
        );

        return;
      }

      const cardData = {
        title: data.title,
        description: data.description,
        priority: data.priority,
        dueDate: data.dueDate,
        columnId: targetColumn.id,
        assignedUserId: data.assignedUserId,
        completed: data.completed || false,
      };

      // Create card in kanban
      const createdCard = await this.kanban.createCard(cardData);

      log.debug(
        {
          businessId: data.businessId,
          entityType: data.entityType,
          entityId: data.entityId,
          cardId: createdCard.id,
        },
        "kanban card created",
      );
    } catch (error) {
      log.error(
        {
          err: error,
          businessId: data.businessId,
          entityType: data.entityType,
          entityId: data.entityId,
        },
        "kanban card could not be created",
      );
      // Does not impede the main flow
    }
  }
}

export {
  KanbanService,
  CreateCardFromServiceOrderProps,
  CreateCardFromEntityProps,
  serviceOrderCardDueDate,
};
