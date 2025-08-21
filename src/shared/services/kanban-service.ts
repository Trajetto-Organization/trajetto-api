import { inject, injectable } from "tsyringe";

import { IKanbanRepository } from "@/modules/kanban/repositories/IKanban-repository";
import { formatCurrency } from "@/config/format-values";

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

      console.log(
        `[KanbanService] ${defaultColumns.length} colunas padrão criadas para empresa ${businessId}`,
      );
    } catch (error) {
      console.error(
        `[KanbanService] Erro ao criar colunas padrão para empresa ${businessId}:`,
        error,
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
        console.log(
          `[KanbanService] Nenhuma coluna encontrada. Criando colunas padrão para empresa ${businessId}...`,
        );

        await this.createDefaultKanbanColumns(businessId);

        // Refetch columns after creation
        const newColumns = await this.kanban.findColumnsByBusinessId(
          businessId,
          false,
        );

        if (newColumns.data.length === 0) {
          console.error(
            `[KanbanService] Erro: Não foi possível criar colunas para empresa ${businessId}`,
          );
          return null;
        }

        console.log(
          `[KanbanService] Colunas padrão criadas para empresa ${businessId}`,
        );
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
          console.log(
            `[KanbanService] Item concluído - usando coluna: ${completedColumn.title}`,
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

      console.log(
        `[KanbanService] Item pendente - usando coluna: ${pendingColumn.title}`,
      );
      return pendingColumn;
    } catch (error) {
      console.error(
        `[KanbanService] Erro ao obter/criar colunas para empresa ${businessId}:`,
        error,
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
      console.log(
        `[KanbanService] Iniciando criação de card para ordem de serviço ${data.serviceOrderId}`,
      );

      // Search or create kanban columns for this company
      const targetColumn = await this.getOrCreateKanbanColumns(
        data.businessId,
        data.completionDate || undefined,
      );

      if (!targetColumn) {
        console.error(
          `[KanbanService] Erro: Não foi possível obter coluna para empresa ${data.businessId}`,
        );
        return;
      }

      // Calculate Due Date (7 days from work order date)
      const orderDate = new Date(data.orderDate);
      const dueDate = new Date(orderDate);

      dueDate.setDate(orderDate.getDate() + 7);

      console.log(`[KanbanService] Data da ordem: ${orderDate.toISOString()}`);
      console.log(
        `[KanbanService] Data de vencimento calculada: ${dueDate.toISOString()}`,
      );

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

      console.log(`[KanbanService] Dados do card a ser criado:`, cardData);

      // Create card in kanban
      const createdCard = await this.kanban.createCard(cardData);

      console.log(
        `[KanbanService] Card criado automaticamente para ordem de serviço ${data.serviceOrderId}. Card ID: ${createdCard.id}`,
      );
    } catch (error) {
      console.error(
        `[KanbanService] Erro ao criar card para ordem de serviço ${data.serviceOrderId}:`,
        error,
      );
      // Does not impede the main flow
    }
  }

  async createCardFromEntity(data: CreateCardFromEntityProps): Promise<void> {
    try {
      console.log(
        `[KanbanService] Iniciando criação de card genérico para ${data.entityType || "entidade"} ${data.entityId || ""}`,
      );

      // Search or create kanban columns for this company
      const targetColumn = await this.getOrCreateKanbanColumns(
        data.businessId,
        data.completed ? new Date() : undefined,
      );

      if (!targetColumn) {
        console.error(
          `[KanbanService] Erro: Não foi possível obter coluna para empresa ${data.businessId}`,
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

      console.log(
        `[KanbanService] Dados do card genérico a ser criado:`,
        cardData,
      );

      // Create card in kanban
      const createdCard = await this.kanban.createCard(cardData);

      console.log(
        `[KanbanService] Card genérico criado. Card ID: ${createdCard.id}`,
      );
    } catch (error) {
      console.error(`[KanbanService] Erro ao criar card genérico:`, error);
      // Does not impede the main flow
    }
  }
}

export {
  KanbanService,
  CreateCardFromServiceOrderProps,
  CreateCardFromEntityProps,
};
