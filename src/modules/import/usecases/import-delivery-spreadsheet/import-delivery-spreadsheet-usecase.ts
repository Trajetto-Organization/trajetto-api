import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";
import { IDeliveryRepository } from "@/modules/delivery/repositories/IDelivery-repository";

import { IRouteRepository } from "@/modules/route/repositories/IRoute-repository";
import { IDriverRepository } from "@/modules/driver/repositories/IDriver-repository";

import { IVehicleRepository } from "@/modules/vehicle/repositories/IVehicle-repository";
import { IImportRepository } from "../../repositories/IImport-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";

import { readSpreadsheet } from "@/shared/delivery/spreadsheet-reader";
import {
  parseDeliverySpreadsheet,
  type ParsedRow,
} from "@/shared/delivery/spreadsheet-parser";

import { AppError } from "@/shared/errors/AppError";

import type {
  ImportRecord,
  ImportReport,
  ImportRowResult,
} from "../../dtos/import-dto";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";
import database from "@/../infra/database";
import { businessToday, resolveTimeZone } from "@/shared/time/business-day";
import { Prisma } from "@prisma/client";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { RouteCodeTakenError } from "@/modules/route/usecases/errors/route-errors";
import { ShipperInactiveError } from "@/modules/shipper/usecases/errors/shipper-errors";
import { logger } from "@/shared/logging/logger";
import {
  deliveryAssignedPayload,
  deliveryEventPayload,
} from "@/shared/integration/announce";

interface ImportDeliverySpreadsheetRequest {
  userId: string;
  businessId: string;

  filename: string;

  /** The file itself, base64 — same shape the XML import already takes. */
  content: string;

  /**
   * One upload is one shipper's load.
   *
   * A spreadsheet has no fiscal issuer to read the cargo owner from, the way
   * an NF-e does, and asking the dispatcher to repeat it on every one of two
   * hundred rows would be asking them to get it wrong once. A file mixing
   * shippers is two uploads.
   */
  shipperId: string;
}

/**
 * How often a running upload proves it is alive.
 *
 * Far inside the sweep's staleness window (close-abandoned-imports-job): even
 * a slow database decides twenty-five rows in seconds, not minutes.
 */
const HEARTBEAT_EVERY_ROWS = 25;

/** What an upload has decided so far — readable when it is interrupted. */
interface ImportProgress {
  rows: ImportRowResult[];

  /** The sheet line being processed; null once every row is decided. */
  line: number | null;
}

/** What the rows of one route group have in common. */
function routeKeyOf(row: ParsedRow): string {
  const route = row.route!;

  return [
    route.name ?? "",
    route.date ? route.date.toISOString() : "",
    route.driverCnh ?? "",
    route.vehiclePlate ?? "",
  ].join("|");
}

/**
 * The first client's way in without an integration.
 *
 * Three rules carried over from the XML import, for the same reasons:
 *
 *  - **One bad row never sinks the batch.** Every row is decided on its own
 *    and reported individually. An import that refuses two hundred deliveries
 *    over one cell is an import people stop using, and then they phone the
 *    numbers in instead.
 *  - **Re-importing the same file is a no-op**, reported as duplicated rather
 *    than as an error: the operator who is not sure whether the upload went
 *    through will click again, and that has to be safe.
 *  - **The report is stored**, not only returned. "Which of the two hundred
 *    failed?" is asked hours later by somebody who did not do the upload.
 *
 * And one that is new here: the route columns CREATE the route, with the rows
 * as its stops in the order they appear in the sheet. That is the order the
 * dispatcher typed, and the order they meant.
 */
@injectable()
class ImportDeliverySpreadsheetUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("RouteRepository")
    private route: IRouteRepository,
    @inject("DriverRepository")
    private driver: IDriverRepository,
    @inject("VehicleRepository")
    private vehicle: IVehicleRepository,
    @inject("ImportRepository")
    private importRepository: IImportRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
  ) {}

  async execute({
    userId,
    businessId,
    filename,
    content,
    shipperId,
  }: ImportDeliverySpreadsheetRequest): Promise<ImportRecord> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    // Loading the company's day is the dispatcher's job.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) throw businessNotFound();

    const findShipper = await this.shipper.findShipperById(shipperId);

    // Same 404 for "does not exist" and "is not yours".
    if (!findShipper || findShipper.businessId !== businessId) {
      throw new AppError(
        "Embarcador não encontrado.",
        404,
        "SHIPPER_NOT_FOUND",
      );
    }

    // A deactivated shipper takes no new deliveries through any door
    // (decision 5.7); the whole upload is its load, so it is refused whole.
    if (findShipper.is_active === false) {
      throw new ShipperInactiveError(findShipper.name);
    }

    // The company's zone: a route row without a date is scheduled for the
    // company's today, not the server's (decision 1.1).
    const timeZone = resolveTimeZone(
      (findBusiness as { timezone?: string | null }).timezone,
    );

    let matrix: unknown[][];

    try {
      matrix = await readSpreadsheet(filename, content);
    } catch (error) {
      // Refused on purpose, with its own sentence (too many rows, too large).
      if (error instanceof AppError) throw error;

      // A corrupt file, or an .xlsx that is not one. The operator needs to
      // know it was the FILE and not their data.
      throw new AppError(
        "Não foi possível ler a planilha. Confira se o arquivo é .xlsx ou .csv e se não está corrompido.",
        400,
        "SPREADSHEET_UNREADABLE",
      );
    }

    const parsed = parseDeliverySpreadsheet(matrix);

    // The record exists before a single row does, so everything created below
    // carries its id from birth. A process that dies halfway then leaves an
    // upload the operator can still undo — once it is closed, by the catch
    // below or by the close-abandoned-imports sweep; stamping the rows at the
    // end would leave orphans no undo could ever group again.
    const record = await this.importRepository.createImport({
      source: "SPREADSHEET",
      filename,
      businessId,
      performedById: userId,
    });

    const progress: ImportProgress = { rows: [], line: null };

    try {
      return await this.importRows(record, parsed, progress, {
        userId,
        businessId,
        shipperId,
        filename,
        timeZone,
      });
    } catch (error) {
      // A failure the process survives — a pool timeout on a lookup, the
      // database dropping the connection — used to leave the upload
      // IN_PROGRESS for good, and the undo refuses a running upload: the rows
      // it had created could never be taken back (IDEMP-10). It is closed
      // here with what it did, and the line it stopped at.
      await this.closeInterrupted(record.id, businessId, parsed, progress);

      throw error;
    }
  }

  /** The rows, the routes and the closing of the record, in that order. */
  private async importRows(
    record: ImportRecord,
    parsed: ReturnType<typeof parseDeliverySpreadsheet>,
    progress: ImportProgress,
    {
      userId,
      businessId,
      shipperId,
      filename,
      timeZone,
    }: Omit<ImportDeliverySpreadsheetRequest, "content"> & { timeZone: string },
  ): Promise<ImportRecord> {
    const rows = progress.rows;

    rows.push(
      ...parsed.errors.map((error) => ({
        line: error.line,
        outcome: "invalid" as const,
        recipient_name: null,
        reference: error.column,
        message: error.message,
      })),
    );

    const createdDeliveryIdByLine = new Map<number, string>();

    for (const [index, row] of parsed.rows.entries()) {
      progress.line = row.line;

      // The heartbeat: what tells a long upload that is alive from one whose
      // process died, for the close-abandoned-imports sweep.
      if (index > 0 && index % HEARTBEAT_EVERY_ROWS === 0) {
        await this.importRepository.touchImport(record.id, businessId);
      }

      const duplicate = await this.findDuplicate(businessId, shipperId, row);

      if (duplicate) {
        rows.push({
          line: row.line,
          outcome: "duplicated",
          recipient_name: row.recipient_name,
          reference: row.invoice_key ?? row.code,
          message: duplicate,
        });

        continue;
      }

      // Identified by the order alone: no unique index stands behind the pair
      // (ADR 0006), so the check above is repeated under a lock inside the
      // insert's transaction.
      const orderOnly = !row.invoice_key && row.code ? row.code : null;

      try {
        // The row and its `delivery.created` in one commit, per row — one bad
        // row still never sinks the batch. The spreadsheet used to announce
        // nothing, and the company's ERP never learned these documents'
        // ids.
        const created = await database.$transaction(async (tx) => {
          if (orderOnly) {
            // Two uploads of the same sheet both pass the check above before
            // either commits. The lock makes the second wait for the first's
            // commit, and the re-read then sees its row.
            await this.delivery.lockOrderIdentity(
              businessId,
              shipperId,
              orderOnly,
              tx,
            );

            const existing = await this.delivery.findDeliveryByShipperAndCode(
              businessId,
              shipperId,
              orderOnly,
              tx,
            );

            if (existing) return null;
          }

          const delivery = await this.delivery.createDelivery(
            {
              businessId,
              shipperId,
              importId: record.id,

              recipient_name: row.recipient_name,
              recipient_document: row.recipient_document,
              recipient_telephone: row.recipient_telephone,
              recipient_email: row.recipient_email,

              cep: row.cep,
              city: row.city,
              uf: row.uf,
              street: row.street,
              address_number: row.address_number,
              complement: row.complement,
              neighborhood: row.neighborhood,

              invoice_key: row.invoice_key,
              invoice_number: row.invoice_number,
              code: row.code,

              scheduled_date: row.scheduled_date,
              notes: row.notes,

              ...(row.item && {
                items: [
                  {
                    description: row.item.description,
                    quantity: row.item.quantity,
                    unit: row.item.unit,
                    unit_value: row.item.unit_value,
                  },
                ],
              }),
            },
            tx,
          );

          await this.webhooks.announce(
            "delivery.created",
            businessId,
            deliveryEventPayload({ ...delivery, id: delivery.id! }),
            tx,
          );

          return delivery;
        });

        if (!created) {
          // Another upload won this order. Left out of createdDeliveryIdByLine,
          // so the route below does not stop at it a second time.
          rows.push({
            line: row.line,
            outcome: "duplicated",
            recipient_name: row.recipient_name,
            reference: row.code,
            message:
              "Este pedido já havia sido importado para este embarcador.",
          });

          continue;
        }

        createdDeliveryIdByLine.set(row.line, created.id!);

        rows.push({
          line: row.line,
          outcome: "imported",
          recipient_name: row.recipient_name,
          reference: row.invoice_key ?? row.code,
          message: null,
        });
      } catch (error) {
        // For a row with an access key, the unique index on (businessId,
        // invoice_key) is the real guard: two operators importing the same
        // file at the same moment collide in the database, not in the check
        // above. Order-only rows are guarded by the lock instead, and never
        // land here as duplicates.
        const isDuplicateKey =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002";

        rows.push({
          line: row.line,
          outcome: isDuplicateKey ? "duplicated" : "invalid",
          recipient_name: row.recipient_name,
          reference: row.invoice_key ?? row.code,
          message: isDuplicateKey
            ? row.invoice_key
              ? "Esta nota já havia sido importada."
              : "Este pedido já havia sido importado para este embarcador."
            : "Não foi possível criar esta entrega.",
        });
      }
    }

    // Every row is decided; what can still fail now is the routes.
    progress.line = null;

    const routes = await this.buildRoutes(
      businessId,
      record.id,
      parsed.rows,
      createdDeliveryIdByLine,
      rows,
      timeZone,
    );

    const report: ImportReport = {
      imported: rows.filter((row) => row.outcome === "imported").length,
      duplicated: rows.filter((row) => row.outcome === "duplicated").length,
      invalid: rows.filter((row) => row.outcome === "invalid").length,
      unknownHeaders: parsed.unknownHeaders,

      // Sorted by line so the report reads like the file the operator is
      // looking at, rather than like the order the code happened to process.
      rows: rows.sort((left, right) => left.line - right.line),
      routes,
    };

    const finished = await this.importRepository.finishImport(
      record.id,
      businessId,
      {
        imported: report.imported,
        duplicated: report.duplicated,
        invalid: report.invalid,
        report,
      },
    );

    this.notificationService.createActivityIfEnabled({
      type: "Entrega",
      action: "create",
      entityId: record.id,
      description:
        `Planilha "${filename}" importada: ${report.imported} entrega(s), ` +
        `${report.duplicated} duplicada(s), ${report.invalid} com erro`,
      status: "Importada",
      performedBy: userId,
      businessId,
    });

    return { ...finished, report };
  }

  /**
   * Closes an upload whose processing threw, with what it had done.
   *
   * The record becomes COMPLETED with the rows decided so far and one line
   * naming where it stopped — which is what the undo accepts. finishImport
   * only closes a record still IN_PROGRESS, so a failure after the record was
   * already closed changes nothing. When even this write fails (the database
   * is gone), the upload stays IN_PROGRESS and close-abandoned-imports closes
   * it once its heartbeat is stale.
   */
  private async closeInterrupted(
    importId: string,
    businessId: string,
    parsed: ReturnType<typeof parseDeliverySpreadsheet>,
    progress: ImportProgress,
  ): Promise<void> {
    const interruption: ImportRowResult =
      progress.line !== null
        ? {
            line: progress.line,
            outcome: "invalid",
            recipient_name: null,
            reference: null,
            message:
              "Importação interrompida por uma falha do servidor nesta linha: " +
              "ela e as seguintes não foram processadas. Estorne esta " +
              "importação e envie o arquivo de novo.",
          }
        : {
            // Every row was decided; the routes were being built. Line 1,
            // where sheet-level problems go.
            line: 1,
            outcome: "invalid",
            recipient_name: null,
            reference: null,
            message:
              "Importação interrompida por uma falha do servidor ao montar as " +
              "rotas: as entregas foram criadas, mas podem ter ficado sem " +
              "rota. Estorne esta importação e envie o arquivo de novo.",
          };

    const rows = [...progress.rows, interruption].sort(
      (left, right) => left.line - right.line,
    );

    const count = (outcome: ImportRowResult["outcome"]) =>
      rows.filter((row) => row.outcome === outcome).length;

    await this.importRepository
      .finishImport(importId, businessId, {
        imported: count("imported"),
        duplicated: count("duplicated"),
        invalid: count("invalid"),
        report: {
          imported: count("imported"),
          duplicated: count("duplicated"),
          invalid: count("invalid"),
          unknownHeaders: parsed.unknownHeaders,
          rows,
          routes: [],
        },
      })
      .catch((error) => {
        logger.error(
          { err: error, importId },
          "could not close an interrupted import; the abandoned-import sweep will",
        );
      });
  }

  /**
   * The access key when there is one, the order number when there is not.
   *
   * Two different identities because two different files: a company that
   * issues invoices has the key, and one that works from orders does not —
   * and refusing the second would refuse the client this whole feature exists
   * for.
   */
  private async findDuplicate(
    businessId: string,
    shipperId: string,
    row: ParsedRow,
  ): Promise<string | null> {
    if (row.invoice_key) {
      const existing = await this.delivery.findDeliveryByInvoiceKey(
        businessId,
        row.invoice_key,
      );

      return existing ? "Esta nota já havia sido importada." : null;
    }

    if (row.code) {
      const existing = await this.delivery.findDeliveryByShipperAndCode(
        businessId,
        shipperId,
        row.code,
      );

      return existing
        ? "Este pedido já havia sido importado para este embarcador."
        : null;
    }

    // Neither a key nor an order number: nothing to be the same as. Importing
    // it twice is the operator's call, and the report will show two lines.
    return null;
  }

  /**
   * Turns the route columns into routes, one per group, stops in sheet order.
   *
   * A group whose driver or vehicle cannot be found does NOT sink its
   * deliveries: they were imported and they are fine, they simply have no
   * route. The report says so on every line of the group, which is what lets
   * the dispatcher fix the CNH and build the route in the panel.
   */
  private async buildRoutes(
    businessId: string,
    importId: string,
    parsedRows: ParsedRow[],
    createdDeliveryIdByLine: Map<number, string>,
    rows: ImportRowResult[],
    timeZone: string,
  ): Promise<ImportReport["routes"]> {
    const groups = new Map<string, ParsedRow[]>();

    for (const row of parsedRows) {
      if (!row.route) continue;
      if (!createdDeliveryIdByLine.has(row.line)) continue;

      const key = routeKeyOf(row);

      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const created: ImportReport["routes"] = [];

    const note = (line: number, message: string) => {
      const entry = rows.find((row) => row.line === line);

      if (entry) {
        entry.message = entry.message ? `${entry.message} ${message}` : message;
      }
    };

    for (const group of groups.values()) {
      // Still alive, for the abandoned-import sweep: a sheet with many route
      // groups spends a while here after its last row.
      await this.importRepository.touchImport(importId, businessId);

      const [first] = group;
      const route = first.route!;

      // Scoped to the company: the CNH is unique per company (decision 8.1),
      // so a global lookup could answer with another carrier's driver.
      const findDriver = route.driverCnh
        ? await this.driver.findDriverByCnh(route.driverCnh, businessId)
        : null;

      if (!findDriver) {
        for (const row of group) {
          note(
            row.line,
            `Entrega importada, mas a rota não foi criada: motorista com CNH ${route.driverCnh} não encontrado.`,
          );
        }

        continue;
      }

      let vehicleId: string | null = null;

      if (route.vehiclePlate) {
        // Same reason as the driver: plates are unique per company.
        const findVehicle = await this.vehicle.findVehicleByLicensePlate(
          route.vehiclePlate,
          businessId,
        );

        if (!findVehicle) {
          for (const row of group) {
            note(
              row.line,
              `Rota criada sem veículo: placa ${route.vehiclePlate} não encontrada.`,
            );
          }
        } else {
          vehicleId = findVehicle.id!;
        }
      }

      /**
       * The route and a `delivery.assigned` per stop, in one commit — the same
       * unit create-route builds. With the caller's transaction the repository
       * reports a code collision instead of retrying, so the whole unit runs
       * again once, as create-route does.
       */
      const build = () =>
        database.$transaction(async (tx) => {
          const built = await this.route.createRoute(
            {
              businessId,
              importId,
              driverId: findDriver.id!,
              vehicleId,
              name: route.name,
              scheduled_date:
                route.date ?? first.scheduled_date ?? businessToday(timeZone),
              deliveryIds: group.map(
                (row) => createdDeliveryIdByLine.get(row.line)!,
              ),
            },
            tx,
          );

          for (const stop of built.stops) {
            await this.webhooks.announce(
              "delivery.assigned",
              businessId,
              deliveryAssignedPayload(stop.delivery, built),
              tx,
            );
          }

          return built;
        });

      try {
        let createdRoute;

        try {
          createdRoute = await build();
        } catch (error) {
          if (!(error instanceof RouteCodeTakenError)) throw error;

          createdRoute = await build();
        }

        created.push({
          id: createdRoute.id,
          code: createdRoute.code,
          name: createdRoute.name,
          stops: createdRoute.stops.length,
        });
      } catch (error) {
        for (const row of group) {
          note(row.line, "Entrega importada, mas a rota não pôde ser criada.");
        }
      }
    }

    return created;
  }
}

export { ImportDeliverySpreadsheetUseCase };
export type { ImportDeliverySpreadsheetRequest };
