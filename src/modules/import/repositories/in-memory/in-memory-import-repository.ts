import { v7 as uuidV7 } from "uuid";

import type { IImportRepository } from "../IImport-repository";
import { ImportAlreadyReversedError } from "../../usecases/errors/import-errors";
import type {
  RemovedDelivery,
  CreateImportProps,
  FinishImportProps,
  ImportRecord,
  ListImportsProps,
  ListImportsPage,
  ReversalResult,
} from "../../dtos/import-dto";

import { compareForOrder } from "@/shared/pagination/in-memory-order";
import {
  IMPORT_SORT_FALLBACK,
  type ImportGroup,
} from "../../usecases/list-imports/import-list";

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
  code?: string | null;
  invoice_key?: string | null;
  invoice_number?: string | null;
  city?: string;
  uf?: string;
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

      // IN_PROGRESS like the real one. A fake that opened an upload as
      // COMPLETED would let a test prove the undo accepts a running import,
      // which is the one thing the status exists to refuse.
      status: "IN_PROGRESS",

      imported: 0,
      duplicated: 0,
      invalid: 0,

      report: {
        imported: 0,
        duplicated: 0,
        invalid: 0,
        unknownHeaders: [],
        rows: [],
        routes: [],
      },

      reversed_at: null,
      created_at: new Date(),
      ...data,
    };

    this.imports.push(created);

    return created;
  }

  async finishImport(
    importId: string,
    businessId: string,
    data: FinishImportProps,
  ): Promise<ImportRecord> {
    const found = this.imports.find(
      (entry) => entry.id === importId && entry.businessId === businessId,
    );

    if (!found) throw new Error("Import not found");

    // Like the real one: only a running upload is closed.
    if (found.status !== "IN_PROGRESS") return found;

    found.status = "COMPLETED";

    found.imported = data.imported;
    found.duplicated = data.duplicated;
    found.invalid = data.invalid;

    found.report = data.report;

    return found;
  }

  /** When each upload last showed signs of life; absent means at creation. */
  public heartbeats = new Map<string, Date>();

  async touchImport(importId: string, businessId: string): Promise<void> {
    const found = this.imports.find(
      (entry) => entry.id === importId && entry.businessId === businessId,
    );

    if (found?.status === "IN_PROGRESS") {
      this.heartbeats.set(importId, new Date());
    }
  }

  async closeAbandonedImports(staleBefore: Date, limit = 100): Promise<number> {
    const stale = this.imports
      .filter(
        (entry) =>
          entry.status === "IN_PROGRESS" &&
          (this.heartbeats.get(entry.id) ?? new Date(entry.created_at)) <
            staleBefore,
      )
      .slice(0, limit);

    for (const entry of stale) {
      const imported = this.deliveries.filter(
        (delivery) =>
          delivery.importId === entry.id &&
          delivery.businessId === entry.businessId,
      ).length;

      entry.status = "COMPLETED";
      entry.imported = imported;
      entry.duplicated = 0;
      entry.invalid = 1;
      entry.report = {
        imported,
        duplicated: 0,
        invalid: 1,
        unknownHeaders: [],
        rows: [
          {
            line: 1,
            outcome: "invalid",
            recipient_name: null,
            reference: null,
            message: "Importação interrompida: o servidor parou antes de terminar o arquivo.",
          },
        ],
        routes: [],
      };
    }

    return stale.length;
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
    includeReport = true,
    sort,
    order,
    statuses,
    sources,
  }: ListImportsProps): Promise<ListImportsPage> {
    const base = this.imports.filter((entry) => entry.businessId === businessId);

    const key = sort ?? IMPORT_SORT_FALLBACK.sort;
    const direction = order ?? (sort ? "asc" : IMPORT_SORT_FALLBACK.order);

    const time = (value: Date | string) => new Date(value);

    // IMPORT_SORT, with its tiebreaker: created_at desc, then id desc.
    const filtered = base
      .filter(
        (entry) =>
          (!statuses?.length || statuses.includes(entry.status)) &&
          (!sources?.length || sources.includes(entry.source)),
      )
      .sort(
        (a, b) =>
          (key === "created_at"
            ? compareForOrder(time(a.created_at), time(b.created_at), direction)
            : compareForOrder(a[key], b[key], direction)) ||
          compareForOrder(time(a.created_at), time(b.created_at), "desc") ||
          compareForOrder(a.id, b.id, "desc"),
      );

    const rows = filtered.slice((page - 1) * pageSize, page * pageSize);

    const groups = new Map<string, ImportGroup>();

    for (const entry of base) {
      const id = `${entry.status}|${entry.source}`;
      const group = groups.get(id) ?? {
        status: entry.status,
        source: entry.source,
        count: 0,
      };

      group.count += 1;
      groups.set(id, group);
    }

    return {
      // Like the real one: asked without reports, the rows have no key at
      // all, not an empty one.
      data: includeReport
        ? rows
        : rows.map(({ report: _report, ...summary }) => summary),
      groups: Array.from(groups.values()),
    };
  }

  async reverseImport(
    importId: string,
    businessId: string,
    onRemoved?: (removed: RemovedDelivery[]) => Promise<void>,
  ): Promise<ReversalResult> {
    const own = (entry: { importId: string | null; businessId: string }) =>
      entry.importId === importId && entry.businessId === businessId;

    // The claim first, like the real one: only a COMPLETED upload is undone,
    // and the loser of a double click is told it already happened.
    const record = this.imports.find(
      (entry) => entry.id === importId && entry.businessId === businessId,
    );

    if (record && record.status !== "COMPLETED") {
      if (record.status === "REVERSED") throw new ImportAlreadyReversedError();

      return {
        removedDeliveries: 0,
        removedRoutes: 0,
        keptDeliveries: [],
        keptRoutes: [],
      };
    }

    if (record) {
      record.status = "REVERSED";
      record.reversed_at = new Date();
    }

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

    // A stop on any route that is not going away — this upload's, kept, or
    // one that never belonged to it — keeps its delivery.
    const deletableDeliveryIds = removableDeliveryIds.filter((deliveryId) => {
      const heldBy = this.routes.find(
        (route) =>
          route.businessId === businessId &&
          !removableRouteIds.includes(route.id) &&
          route.stopDeliveryIds.includes(deliveryId),
      );

      if (!heldBy) return true;

      const delivery = this.deliveries.find((entry) => entry.id === deliveryId)!;

      keptDeliveries.push({
        id: delivery.id,
        recipient_name: delivery.recipient_name,
        reason: "Está numa rota que não pode ser desfeita.",
      });

      return false;
    });

    this.routes = this.routes.filter(
      (route) => !removableRouteIds.includes(route.id),
    );

    const removedRows = this.deliveries.filter((delivery) =>
      deletableDeliveryIds.includes(delivery.id),
    );

    this.deliveries = this.deliveries.filter(
      (delivery) => !deletableDeliveryIds.includes(delivery.id),
    );

    if (onRemoved && removedRows.length > 0) {
      await onRemoved(
        removedRows.map((row) => ({
          id: row.id,
          code: row.code ?? null,
          invoice_key: row.invoice_key ?? null,
          invoice_number: row.invoice_number ?? null,
          recipient_name: row.recipient_name,
          city: row.city ?? "",
          uf: row.uf ?? "",
        })),
      );
    }

    // Whatever survived stops claiming to be part of this upload.
    for (const entry of [...this.deliveries, ...this.routes]) {
      if (entry.importId === importId && entry.businessId === businessId) {
        entry.importId = null;
      }
    }

    return {
      removedDeliveries: deletableDeliveryIds.length,
      removedRoutes: removableRouteIds.length,
      keptDeliveries,
      keptRoutes,
    };
  }
}

export { InMemoryImportRepository };
export type { ReversibleDelivery, ReversibleRoute };
