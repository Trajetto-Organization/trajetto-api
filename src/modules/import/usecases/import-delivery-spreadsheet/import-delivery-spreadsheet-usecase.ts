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

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

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
  ) {}

  async execute({
    userId,
    businessId,
    filename,
    content,
    shipperId,
  }: ImportDeliverySpreadsheetRequest): Promise<ImportRecord> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    // Loading the company's day is the dispatcher's job.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) throw new BusinessNotFoundError();

    const findShipper = await this.shipper.findShipperById(shipperId);

    // Same 404 for "does not exist" and "is not yours".
    if (!findShipper || findShipper.businessId !== businessId) {
      throw new AppError("Embarcador não encontrado.", 404, "SHIPPER_NOT_FOUND");
    }

    let matrix: unknown[][];

    try {
      matrix = await readSpreadsheet(filename, content);
    } catch (error) {
      // A corrupt file, or an .xlsx that is not one. The operator needs to
      // know it was the FILE and not their data.
      throw new AppError(
        "Não foi possível ler a planilha. Confira se o arquivo é .xlsx ou .csv e se não está corrompido.",
        400,
        "SPREADSHEET_UNREADABLE",
      );
    }

    const parsed = parseDeliverySpreadsheet(matrix);

    const rows: ImportRowResult[] = parsed.errors.map((error) => ({
      line: error.line,
      outcome: "invalid" as const,
      recipient_name: null,
      reference: error.column,
      message: error.message,
    }));

    const createdDeliveryIdByLine = new Map<number, string>();

    for (const row of parsed.rows) {
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

      try {
        const created = await this.delivery.createDelivery({
          businessId,
          shipperId,
          importId: null,

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
        });

        createdDeliveryIdByLine.set(row.line, created.id!);

        rows.push({
          line: row.line,
          outcome: "imported",
          recipient_name: row.recipient_name,
          reference: row.invoice_key ?? row.code,
          message: null,
        });
      } catch (error) {
        // The unique index on (businessId, invoice_key) is the real guard:
        // two operators importing the same file at the same moment collide
        // in the database, not in the check above.
        const isDuplicateKey =
          error instanceof Error && error.message.includes("Unique constraint");

        rows.push({
          line: row.line,
          outcome: isDuplicateKey ? "duplicated" : "invalid",
          recipient_name: row.recipient_name,
          reference: row.invoice_key ?? row.code,
          message: isDuplicateKey
            ? "Esta nota já havia sido importada."
            : "Não foi possível criar esta entrega.",
        });
      }
    }

    const routes = await this.buildRoutes(
      businessId,
      parsed.rows,
      createdDeliveryIdByLine,
      rows,
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

    const record = await this.importRepository.createImport({
      source: "SPREADSHEET",
      filename,
      imported: report.imported,
      duplicated: report.duplicated,
      invalid: report.invalid,
      report,
      businessId,
      performedById: userId,
    });

    // The rows are stamped after the import exists — it is the parent, and a
    // delivery pointing at an import that had not been written yet would be a
    // foreign key with nothing behind it.
    await this.delivery.stampImport(
      [...createdDeliveryIdByLine.values()],
      record.id,
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

    return { ...record, report };
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
    parsedRows: ParsedRow[],
    createdDeliveryIdByLine: Map<number, string>,
    rows: ImportRowResult[],
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
      const [first] = group;
      const route = first.route!;

      const findDriver = route.driverCnh
        ? await this.driver.findDriverByDriverLicense(route.driverCnh)
        : null;

      if (!findDriver || findDriver.businessId !== businessId) {
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
        const findVehicle = await this.vehicle.findVehicleByLicensePlate(
          route.vehiclePlate,
        );

        if (!findVehicle || findVehicle.businessId !== businessId) {
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

      try {
        const createdRoute = await this.route.createRoute({
          businessId,
          driverId: findDriver.id!,
          vehicleId,
          name: route.name,
          scheduled_date: route.date ?? first.scheduled_date ?? new Date(),
          deliveryIds: group.map(
            (row) => createdDeliveryIdByLine.get(row.line)!,
          ),
        });

        created.push({
          id: createdRoute.id,
          code: createdRoute.code,
          name: createdRoute.name,
          stops: createdRoute.stops.length,
        });
      } catch (error) {
        for (const row of group) {
          note(
            row.line,
            "Entrega importada, mas a rota não pôde ser criada.",
          );
        }
      }
    }

    return created;
  }
}

export { ImportDeliverySpreadsheetUseCase };
export type { ImportDeliverySpreadsheetRequest };
