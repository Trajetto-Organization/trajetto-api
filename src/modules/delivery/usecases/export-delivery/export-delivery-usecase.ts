import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";

import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";
import { AppError } from "@/shared/errors/AppError";

interface ExportDeliveryRequest {
  userId: string;
  businessId?: string;
  search?: string;
  status?: string;
}

/**
 * The operation, as a spreadsheet.
 *
 * Streamed in batches rather than loaded and serialised: an export is the one
 * screen where a company with five million deliveries asks for all of them,
 * and the difference between a cursor loop and a `findMany` is the difference
 * between a download and a dead replica.
 *
 * Statuses come out in Portuguese. An export is read by a person in Excel, not
 * parsed by a machine, and "IN_TRANSIT" in a column called Status is a column
 * that has to be explained every time.
 */
@injectable()
class ExportDeliveryUseCase {
  constructor(
    @inject("UserRepository")
    private user: IUserRepository,
    @inject("DeliveryRepository")
    private delivery: IDeliveryRepository,
  ) {}

  async execute({
    userId,
    businessId,
    search,
    status,
  }: ExportDeliveryRequest): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw new ResourceNotFoundError();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    // A driver exporting gets their own work, the same way their listing does.
    const iterator = this.delivery.streamDeliveriesForExport({
      businessId: resolvedBusinessId,
      driverId: findUser.driverId ?? undefined,
      search,
      status,
    });

    const columns: ExportColumn[] = [
      { header: "ID", key: "id", width: 38, formatter: ExportFormatters.fallback },
      { header: "Pedido", key: "code", width: 18, formatter: ExportFormatters.fallback },
      { header: "Chave da NF-e", key: "invoice_key", width: 46, formatter: ExportFormatters.fallback },
      { header: "Número da NF", key: "invoice_number", width: 14, formatter: ExportFormatters.fallback },
      { header: "Status", key: "status", width: 14, formatter: ExportFormatters.fallback },
      { header: "Destinatário", key: "recipient_name", width: 32, formatter: ExportFormatters.fallback },
      { header: "Documento", key: "recipient_document", width: 20, formatter: ExportFormatters.fallback },
      { header: "Telefone", key: "recipient_telephone", width: 18, formatter: ExportFormatters.phone },
      { header: "Logradouro", key: "street", width: 32, formatter: ExportFormatters.fallback },
      { header: "Número", key: "address_number", width: 10, formatter: ExportFormatters.fallback },
      { header: "Bairro", key: "neighborhood", width: 20, formatter: ExportFormatters.fallback },
      { header: "Cidade", key: "city", width: 24, formatter: ExportFormatters.fallback },
      { header: "UF", key: "uf", width: 6, formatter: ExportFormatters.fallback },
      { header: "CEP", key: "cep", width: 12, formatter: ExportFormatters.fallback },
      { header: "Embarcador", key: "shipperName", width: 28, formatter: ExportFormatters.fallback },
      { header: "Motorista", key: "driverName", width: 28, formatter: ExportFormatters.fallback },
      { header: "Veículo", key: "vehiclePlate", width: 12, formatter: ExportFormatters.fallback },
      { header: "Rota", key: "routeCode", width: 10, formatter: ExportFormatters.fallback },
      { header: "Data prevista", key: "scheduled_date", width: 16, formatter: ExportFormatters.date },
      { header: "Entregue em", key: "delivered_at", width: 20, formatter: ExportFormatters.datetime },
      { header: "Recebido por", key: "received_by", width: 24, formatter: ExportFormatters.fallback },
      { header: "Observações", key: "notes", width: 40, formatter: ExportFormatters.fallback },
    ];

    const today = new Date().toISOString().slice(0, 10);

    return { iterator, columns, filename: `entregas-${today}` };
  }
}

export { ExportDeliveryUseCase };
export { DELIVERY_STATUS_LABELS };
