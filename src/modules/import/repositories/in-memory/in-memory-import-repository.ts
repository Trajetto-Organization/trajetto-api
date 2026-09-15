import { v7 as uuidV7 } from "uuid";

import type { IImportRepository } from "../IImport-repository";
import type {
  CreateImportProps,
  ImportRecord,
  ListImportsProps,
  ListImportsResult,
  ReversalResult,
} from "../../dtos/import-dto";

/**
 * The reversal's rules, mirrored.
 *
 * The real one reads counts of events, occurrences and stops out of Postgres;
 * here a test states them directly through the seams below. What must NOT
 * differ is the decision: which rows are removable, and why the others are
 * kept — a fake that removed a delivery the database would refuse to remove
 * would let a test prove the opposite of the truth.
 */
interface ReversibleDelivery {
  id: string;
  businessId: string;
  importId: string | null;
  recipient_name: string;
  status: string;
  eventCount?: number;
  occurrenceCount?: number;
}

interface ReversibleRoute {
  id: string;
  businessId: string;
  importId: string | null;
  code: number;
  status: string;
  stopDeliveryIds: string[];
}

class InMemoryImportRepository implements IImportRepository {
  public imports: ImportRecord[] = [];

  public deliveries: ReversibleDelivery[] = [];
  public routes: ReversibleRoute[] = [];

  async createImport(data: CreateImportProps): Promise<ImportRecord> {
    const created: ImportRecord = {
      id: uuidV7(),
      status: "COMPLETED",
      reversed_at: null,
      created_at: new Date(),
      ...data,
    };

    this.imports.push(created);

    return created;
  }

  async findImportById(
    importId: string,
    businessId: string,
  ): Promise<ImportRecord | null> {
    return (
      this.imports.find(
        (entry) => entry.id === importId && entry.businessId === businessId,
      ) ?? null
    );
  }

  async listImports({
    businessId,
    page,
    pageSize,
  }: ListImportsProps): Promise<ListImportsResult> {
    const filtered = this.imports.filter(
      (entry) => entry.businessId === businessId,
    );

    return {
      data: filtered.slice((page - 1) * pageSize, page * pageSize),
      total: filtered.length,
    };
  }

  async reverseImport(
    importId: string,
    businessId: string,
  ): Promise<ReversalResult> {
    const own = (entry: { importId: string | null; businessId: string }) =>
      entry.importId === importId && entry.businessId === businessId;

    const keptDeliveries: ReversalResult["keptDeliveries"] = [];
    const removableDeliveryIds: string[] = [];

    for (const delivery of this.deliveries.filter(own)) {
      const reason =
        delivery.status !== "PENDING"
          ? "Já saiu do status pendente."
          : (delivery.eventCount ?? 0) > 0
            ? "Já tem registros do motorista."
            : (delivery.occurrenceCount ?? 0) > 0
              ? "Já tem ocorrência registrada."
              : null;

      if (reason) {
        keptDeliveries.push({
          id: delivery.id,
          recipient_name: delivery.recipient_name,
          reason,
        });

        continue;
      }

      removableDeliveryIds.push(delivery.id);
    }

    const removable = new Set(removableDeliveryIds);

    const keptRoutes: ReversalResult["keptRoutes"] = [];
    const removableRouteIds: string[] = [];

    for (const route of this.routes.filter(own)) {
      const reason =
        route.status !== "PLANNED"
          ? "Já foi liberada ou já saiu."
          : route.stopDeliveryIds.some((id) => !removable.has(id))
            ? "Tem paradas de entregas que não puderam ser removidas."
            : null;

      if (reason) {
        keptRoutes.push({ id: route.id, code: route.code, reason });
        continue;
      }

      removableRouteIds.push(route.id);
    }

    this.routes = this.routes.filter(
      (route) => !removableRouteIds.includes(route.id),
    );

    this.deliveries = this.deliveries.filter(
      (delivery) => !removableDeliveryIds.includes(delivery.id),
    );

    // Whatever survived stops claiming to be part of this upload.
    for (const entry of [...this.deliveries, ...this.routes]) {
      if (entry.importId === importId && entry.businessId === businessId) {
        entry.importId = null;
      }
    }

    const record = this.imports.find(
      (entry) => entry.id === importId && entry.businessId === businessId,
    );

    if (record && record.status === "COMPLETED") {
      record.status = "REVERSED";
      record.reversed_at = new Date();
    }

    return {
      removedDeliveries: removableDeliveryIds.length,
      removedRoutes: removableRouteIds.length,
      keptDeliveries,
      keptRoutes,
    };
  }
}

export { InMemoryImportRepository };
export type { ReversibleDelivery, ReversibleRoute };
