import { inject, injectable } from "tsyringe";
import { Prisma } from "@prisma/client";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";

import { IShipperRepository } from "@/modules/shipper/repositories/IShipper-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { NotificationService } from "@/shared/services/notification-service";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { BusinessNotFoundError } from "@/modules/business/usecases/errors/business-not-found-error";

import {
  ShipperNotFoundError,
  ShipperNotBelongBusinessError,
} from "@/modules/shipper/usecases/errors/shipper-errors";

import { parseNFeXml, NFeParseError } from "@/shared/delivery/nfe-parser";
import { AppError } from "@/shared/errors/AppError";

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
  scheduled_date?: Date;
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
  imported: number;
  duplicated: number;
  invalid: number;
  created_shippers: string[];
  results: ImportResultItem[];
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
 *   response lists what was created so nothing appears silently.
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
      throw new ResourceNotFoundError();
    }

    // Dispatcher-only: the driver permission table opens delivery_manage so
    // the app's own routes work, which would otherwise open management too.
    // Creating, editing, importing and assigning belong to the dispatcher.
    if (findUser.driverId) {
      throw new AppError(
        "Motoristas não gerenciam entregas: criação, edição e atribuição são do despachante.",
        403,
        "DRIVER_CANNOT_MANAGE_DELIVERIES",
      );
    }

    const findBusiness = await this.business.findBusinessById(businessId);

    if (!findBusiness) {
      throw new BusinessNotFoundError();
    }

    if (shipperId) {
      const forcedShipper = await this.shipper.findShipperById(shipperId);

      if (!forcedShipper) {
        throw new ShipperNotFoundError();
      }

      if (forcedShipper.businessId !== businessId) {
        throw new ShipperNotBelongBusinessError();
      }
    }

    const results: ImportResultItem[] = [];
    const createdShippers: string[] = [];

    for (const file of files) {
      results.push(
        await this.importSingleFile({
          file,
          businessId,
          forcedShipperId: shipperId,
          scheduled_date,
          createdShippers,
        }),
      );
    }

    const summary: ImportSummary = {
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

  private async importSingleFile({
    file,
    businessId,
    forcedShipperId,
    scheduled_date,
    createdShippers,
  }: {
    file: ImportFile;
    businessId: string;
    forcedShipperId?: string;
    scheduled_date?: Date;
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
      await this.delivery.createDelivery({
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
        items: parsed.items.map((item) => ({
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          unit_value: item.unit_value,
        })),
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

      if (process.env.NODE_ENV === "development") {
        console.error("[ImportDeliveryXml] Falha ao criar entrega:", error);
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
   * CNPJ (the stable identity); created when the carrier has never received
   * cargo from it before.
   */
  private async resolveShipperFromIssuer({
    businessId,
    issuerCnpj,
    issuerName,
    createdShippers,
  }: {
    businessId: string;
    issuerCnpj: string | null;
    issuerName: string | null;
    createdShippers: string[];
  }): Promise<string> {
    if (issuerCnpj) {
      const byCnpj = await this.shipper.findShipperByCnpj(
        businessId,
        issuerCnpj,
      );

      if (byCnpj?.id) return byCnpj.id;
    }

    if (!issuerName) {
      throw new AppError(
        "A nota não identifica o emitente. Selecione o embarcador manualmente ao importar.",
        400,
      );
    }

    const byName = await this.shipper.findShipperByName(businessId, issuerName);

    if (byName?.id) return byName.id;

    const created = await this.shipper.createShipper({
      businessId,
      name: issuerName,
      cnpj: issuerCnpj,
    });

    createdShippers.push(issuerName);
    return created.id as string;
  }
}

export { ImportDeliveryXmlUseCase };
export type { ImportSummary, ImportResultItem };
