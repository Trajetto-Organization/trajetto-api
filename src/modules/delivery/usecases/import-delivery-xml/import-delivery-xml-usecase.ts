import { inject, injectable } from "tsyringe";
import { Prisma } from "@prisma/client";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";

import {
  ShipperNotFoundError,
  ShipperInactiveError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { parseNFeXml, NFeParseError } from "@/shared/delivery/nfe-parser";
import { AppError } from "@/shared/errors/AppError";
import { assertDispatcher } from "@/shared/delivery/dispatcher-guard";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import {
  businessNotFound,
  callerNotFound,
} from "@/shared/delivery/caller-not-found";
import type {
  ImportRecord,
  ImportReport,
  ImportRowResult,
} from "@/modules/import/dtos/import-dto";
import database from "@/../infra/database";
import type { Shipper } from "@/modules/shipper/dtos/shipper-dto";
import { IImportRepository } from "@/modules/import/repositories/IImport-repository";
import { WebhookFanOutService } from "@/shared/integration/webhook-fan-out-service";
import { deliveryEventPayload } from "@/shared/integration/announce";
import { sendCatalogChangedEvent } from "@/websocket";
import { logger } from "@/shared/logging/logger";

const log = logger.child({ component: "delivery" });

interface ImportFile {
  filename: string;
  content: string;
}

interface ImportRequest {
  userId: string;
  businessId: string;
  files: ImportFile[];
  /** Optional override — otherwise the NF-e issuer becomes the shipper. */
  shipperId?: string;
  /** A civil date (UTC midnight of the chosen day), decision 1.3. */
  scheduled_date?: Date | null;
}

type ImportOutcome = "imported" | "duplicated" | "invalid";

interface ImportResultItem {
  filename: string;
  outcome: ImportOutcome;
  invoice_key: string | null;
  recipient_name: string | null;
  message: string | null;
}

interface ImportSummary {
  /** The Importações row this upload wrote (decision 5.6). */
  importId: string;
  imported: number;
  duplicated: number;
  invalid: number;
  created_shippers: string[];
  results: ImportResultItem[];
}

/** Heartbeat cadence, in files: what tells a live upload from a dead one. */
const HEARTBEAT_EVERY_FILES = 10;

/** "nota.xml", or "nota.xml e mais 3 arquivos" — the Importações file column. */
function uploadLabel(files: ImportFile[]): string {
  const [first] = files;
  const rest = files.length - 1;

  const label =
    rest === 0
      ? first.filename
      : `${first.filename} e mais ${rest} arquivo${rest > 1 ? "s" : ""}`;

  return label.slice(0, 255);
}

function reportOf(results: ImportResultItem[]): ImportReport {
  const rows: ImportRowResult[] = results.map((result, index) => ({
    // One line per file, in the order they were sent.
    line: index + 1,
    outcome: result.outcome,
    recipient_name: result.recipient_name,
    reference: result.invoice_key ?? result.filename,
    message:
      result.outcome === "imported"
        ? null
        : `${result.filename}: ${result.message ?? ""}`.trim(),
  }));

  return {
    imported: results.filter((r) => r.outcome === "imported").length,
    duplicated: results.filter((r) => r.outcome === "duplicated").length,
    invalid: results.filter((r) => r.outcome === "invalid").length,
    unknownHeaders: [],
    rows,
    routes: [],
  };
}

/**
 * Manual XML import: the operator drops the NF-e files they already have and
 * each one becomes a delivery.
 *
 * Design decisions worth keeping:
 * - **One bad file never sinks the batch.** Every file is processed on its
 *   own and reported individually — an import screen must say which file
 *   failed and why, not refuse the whole upload.
 * - **The access key is the identity.** Re-importing the same file is a
 *   no-op reported as duplicated, and the unique index (businessId,
 *   invoice_key) is what enforces it — two replicas importing the same file
 *   at once collide in the database, not in memory.
 * - **The NF-e issuer is the shipper.** It is the cargo owner by fiscal
 *   definition, so it is matched by CNPJ and created when unknown; the
 *   response lists what was created so nothing appears silently. A
 *   deactivated shipper takes no new notes (decision 5.7).
 * - **Every upload is an Importações row** (decision 5.6), like the
 *   spreadsheet: the record exists before the first delivery, each delivery
 *   carries its id, and the upload can be reversed.
 */
@injectable()
class ImportDeliveryXmlUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("BusinessRepository")
    private business: IBusinessRepository,
    @inject("ShipperRepository")
    private shipper: IShipperRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
    @inject("NotificationService")
    private notificationService: NotificationService,
    @inject("WebhookFanOutService")
    private webhooks: WebhookFanOutService,
    @inject("ImportRepository")
    private importRepository: IImportRepository,
  ) {}

  async execute({
    userId,
    businessId,
    files,
    shipperId,
    scheduled_date,
  }: ImportRequest): Promise<ImportSummary> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) {
      throw callerNotFound();
    }

    // Defense in depth: the route guard must not be the only wall between
    // tenants (same check as get-delivery and the list/exports).
    assertTenantAccess(findUser, businessId);

    // One definition, shared: see assertDispatcher.
    assertDispatcher(findUser);

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw businessNotFound();
    }

    if (shipperId) {
      const forcedShipper = await this.shipper.findShipperById(shipperId);

      // Another company's id reads as absent (decision 11.3).
      if (!forcedShipper || forcedShipper.businessId !== businessId) {
        throw new ShipperNotFoundError();
      }

      // The operator chose it for every note of the upload: refusing the
      // whole request is the honest answer, before anything is written.
      if (forcedShipper.is_active === false) {
        throw new ShipperInactiveError(forcedShipper.name);
      }
    }

    // Opened before the first delivery, so each one carries the upload's id
    // from birth and a process dying mid-way leaves an upload the operator
    // can still reverse (closed by the abandoned-import sweep).
    const record = await this.importRepository.createImport({
      source: "NFE_XML",
      filename: uploadLabel(files),
      businessId,
      performedById: userId,
    });

    const results: ImportResultItem[] = [];
    const createdShippers: string[] = [];

    try {
      for (const [index, file] of files.entries()) {
        if (index > 0 && index % HEARTBEAT_EVERY_FILES === 0) {
          await this.importRepository.touchImport(record.id, businessId);
        }

        results.push(
          await this.importSingleFile({
            file,
            businessId,
            importId: record.id,
            forcedShipperId: shipperId,
            scheduled_date,
            createdShippers,
          }),
        );
      }
    } catch (error) {
      // A failure the process survives (the database dropping the connection)
      // closes the upload with what it did, so it can be reversed; the
      // remaining files are reported as not processed.
      await this.closeUpload(record, businessId, [
        ...results,
        ...files.slice(results.length).map((file) => ({
          filename: file.filename,
          outcome: "invalid" as const,
          invoice_key: null,
          recipient_name: null,
          message:
            "Importação interrompida antes deste arquivo. Estorne esta importação e envie os arquivos de novo.",
        })),
      ]);

      if (createdShippers.length > 0) {
        sendCatalogChangedEvent(businessId, "shipper");
      }

      throw error;
    }

    await this.closeUpload(record, businessId, results);

    // New shippers from issuers: the pickers and the Embarcadores tab of
    // every open screen refetch (after the commits above).
    if (createdShippers.length > 0) {
      sendCatalogChangedEvent(businessId, "shipper");
    }

    const summary: ImportSummary = {
      importId: record.id,
      imported: results.filter((r) => r.outcome === "imported").length,
      duplicated: results.filter((r) => r.outcome === "duplicated").length,
      invalid: results.filter((r) => r.outcome === "invalid").length,
      created_shippers: createdShippers,
      results,
    };

    if (summary.imported > 0) {
      // Process activity asynchronously without blocking the main flow
      this.notificationService.createActivityIfEnabled({
        type: "Entrega",
        action: "create",
        entityId: businessId,
        description:
          `Importação de XML: ${summary.imported} entrega(s) criada(s), ` +
          `${summary.duplicated} duplicada(s), ${summary.invalid} inválida(s)`,
        status: "Completo",
        performedBy: userId,
        businessId,
      });
    }

    return summary;
  }

  private async closeUpload(
    record: ImportRecord,
    businessId: string,
    results: ImportResultItem[],
  ): Promise<void> {
    const report = reportOf(results);

    await this.importRepository.finishImport(record.id, businessId, {
      imported: report.imported,
      duplicated: report.duplicated,
      invalid: report.invalid,
      report,
    });
  }

  private async importSingleFile({
    file,
    businessId,
    importId,
    forcedShipperId,
    scheduled_date,
    createdShippers,
  }: {
    file: ImportFile;
    businessId: string;
    importId: string;
    forcedShipperId?: string;
    scheduled_date?: Date | null;
    createdShippers: string[];
  }): Promise<ImportResultItem> {
    let parsed;

    try {
      parsed = parseNFeXml(file.content);
    } catch (error) {
      return {
        filename: file.filename,
        outcome: "invalid",
        invoice_key: null,
        recipient_name: null,
        message:
          error instanceof NFeParseError
            ? error.message
            : "Não foi possível interpretar o arquivo.",
      };
    }

    const existing = await this.delivery.findDeliveryByInvoiceKey(
      businessId,
      parsed.invoice_key,
    );

    if (existing) {
      return {
        filename: file.filename,
        outcome: "duplicated",
        invoice_key: parsed.invoice_key,
        recipient_name: parsed.recipient_name,
        message: "Esta nota já havia sido importada.",
      };
    }

    let resolvedShipperId: string;

    try {
      resolvedShipperId =
        forcedShipperId ??
        (await this.resolveShipperFromIssuer({
          businessId,
          issuerCnpj: parsed.issuer_cnpj,
          issuerName: parsed.issuer_name,
          issuerLegalName: parsed.issuer_legal_name,
          createdShippers,
        }));
    } catch (error) {
      return {
        filename: file.filename,
        outcome: "invalid",
        invoice_key: parsed.invoice_key,
        recipient_name: parsed.recipient_name,
        message:
          error instanceof AppError
            ? error.message
            : "Não foi possível determinar o embarcador desta nota.",
      };
    }

    try {
      // The row and its `delivery.created` in one commit, per file — so one
      // bad file still never sinks the batch. The import is the main way
      // documents enter the operation, and it used to announce nothing: an
      // ERP subscribed to `delivery.created` heard only about the ones typed
      // into the form.
      await database.$transaction(async (tx) => {
        const created = await this.delivery.createDelivery(
          {
            businessId,
            shipperId: resolvedShipperId,
            invoice_key: parsed.invoice_key,
            invoice_number: parsed.invoice_number,
            recipient_name: parsed.recipient_name,
            recipient_document: parsed.recipient_document,
            recipient_email: parsed.recipient_email,
            recipient_telephone: parsed.recipient_telephone,
            cep: parsed.cep,
            city: parsed.city,
            uf: parsed.uf,
            street: parsed.street,
            address_number: parsed.address_number,
            complement: parsed.complement,
            neighborhood: parsed.neighborhood,
            scheduled_date: scheduled_date ?? null,
            importId,
            items: parsed.items.map((item) => ({
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              unit_value: item.unit_value,
            })),
          },
          tx,
        );

        await this.webhooks.announce(
          "delivery.created",
          businessId,
          deliveryEventPayload({ ...created, id: created.id! }),
          tx,
        );
      });

      return {
        filename: file.filename,
        outcome: "imported",
        invoice_key: parsed.invoice_key,
        recipient_name: parsed.recipient_name,
        message: null,
      };
    } catch (error) {
      // P2002 = the unique (businessId, invoice_key) fired: another replica
      // (or a double click) imported the same note in between.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return {
          filename: file.filename,
          outcome: "duplicated",
          invoice_key: parsed.invoice_key,
          recipient_name: parsed.recipient_name,
          message: "Esta nota já havia sido importada.",
        };
      }

      // Development only, as before: a Prisma validation error quotes the
      // whole row it refused — recipient, address, document.
      if (process.env.NODE_ENV === "development") {
        log.warn(
          { err: error, filename: file.filename },
          "XML import could not create the delivery",
        );
      }

      return {
        filename: file.filename,
        outcome: "invalid",
        invoice_key: parsed.invoice_key,
        recipient_name: parsed.recipient_name,
        message: "Houve um erro ao registrar a entrega desta nota.",
      };
    }
  }

  /**
   * The NF-e issuer is the cargo owner, so it is the shipper. Matched by
   * CNPJ (the stable identity, unique per company); by name only when the
   * registered shipper has no CNPJ — a matriz and a filial share the
   * corporate name and must not be merged. Created when the carrier has
   * never received cargo from it before. A deactivated match refuses the
   * note: creating another would clash with its name and bypass the decision
   * to deactivate it.
   */
  private async resolveShipperFromIssuer({
    businessId,
    issuerCnpj,
    issuerName,
    issuerLegalName = null,
    createdShippers,
  }: {
    businessId: string;
    issuerCnpj: string | null;
    issuerName: string | null;
    /** emit/xNome: the legal name the proof document prints (decision 14.8). */
    issuerLegalName?: string | null;
    createdShippers: string[];
  }): Promise<string> {
    const existing = await this.findIssuerShipper(
      businessId,
      issuerCnpj,
      issuerName,
    );

    if (existing) return this.usable(existing);

    if (!issuerName) {
      throw new AppError(
        "A nota não identifica o emitente. Selecione o embarcador manualmente ao importar.",
        400,
        "NFE_ISSUER_UNKNOWN",
      );
    }

    try {
      const created = await this.shipper.createShipper({
        businessId,
        name: issuerName,
        corporate_reason: issuerLegalName,
        cnpj: issuerCnpj,
      });

      createdShippers.push(issuerName);
      return created.id as string;
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2002"
      ) {
        throw error;
      }

      // Another replica (or a concurrent upload) created this issuer between
      // the read above and the insert: the unique index decided, and the
      // row it kept is the answer (DLV-SHP-5).
      const winner = await this.findIssuerShipper(
        businessId,
        issuerCnpj,
        issuerName,
      );

      if (winner) return this.usable(winner);

      // The name is taken by a shipper with ANOTHER CNPJ.
      throw new AppError(
        `Já existe um embarcador chamado ${issuerName} com outro CNPJ. Selecione o embarcador manualmente ao importar.`,
        400,
        "NFE_ISSUER_NAME_TAKEN",
      );
    }
  }

  private async findIssuerShipper(
    businessId: string,
    issuerCnpj: string | null,
    issuerName: string | null,
  ): Promise<Shipper | null> {
    if (issuerCnpj) {
      const byCnpj = await this.shipper.findShipperByCnpj(
        businessId,
        issuerCnpj,
      );

      if (byCnpj) return byCnpj;
    }

    if (!issuerName) return null;

    const byName = await this.shipper.findShipperByName(businessId, issuerName);

    if (!byName) return null;

    // Same name, different fiscal identity: not the same shipper.
    if (issuerCnpj && byName.cnpj && byName.cnpj !== issuerCnpj) return null;

    return byName;
  }

  private usable(shipper: Shipper): string {
    if (shipper.is_active === false) {
      throw new ShipperInactiveError(shipper.name);
    }

    return shipper.id as string;
  }
}

export { ImportDeliveryXmlUseCase };
export type { ImportSummary, ImportResultItem };
