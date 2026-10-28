import { inject, injectable } from "tsyringe";

import { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import { IDeliveryRepository } from "../../repositories/IDelivery-repository";
import { assertTenantAccess } from "@/modules/middlewares/tenant-authorization";

import { ExportFormatters } from "@/shared/services/export/formatters";
import { ExportColumn } from "@/shared/services/export/types";

import {
  DELIVERY_STATUS_LABELS,
  DeliveryStatus,
} from "@/shared/delivery/delivery-rules";
import { AppError } from "@/shared/errors/AppError";

import { callerNotFound } from "@/shared/delivery/caller-not-found";
import { businessDateKey, resolveTimeZone } from "@/shared/time/business-day";
import { IBusinessRepository } from "@/modules/business/repositories/IBusiness-repository";
import { formatDateOnlyBR } from "@/shared/delivery/date-only-field";
import { formatInstant } from "@/shared/vehicle/record-dates";
import type { DeliveryKind } from "@/shared/delivery/delivery-kind";
import {
  deliveryPeriodWindow,
  type DeliveryPeriodInput,
} from "@/modules/delivery/usecases/list-delivery/delivery-period";

interface ExportDeliveryRequest extends DeliveryPeriodInput {
  userId: string;
  businessId?: string;
  search?: string;
  statuses?: DeliveryStatus[];
  shipperIds?: string[];
  driverIds?: string[];
  kinds?: DeliveryKind[];
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
    @inject("BusinessRepository")
    private business: IBusinessRepository,
  ) {}

  async execute({
    userId,
    businessId,
    search,
    statuses,
    shipperIds,
    driverIds,
    kinds,
    period,
    from,
    to,
  }: ExportDeliveryRequest): Promise<{
    iterator: AsyncGenerator<any>;
    columns: ExportColumn[];
    filename: string;
  }> {
    const findUser = await this.user.findUserById(userId);

    if (!findUser) throw callerNotFound();

    const resolvedBusinessId = businessId ?? findUser.businessId;

    if (!resolvedBusinessId) {
      throw new AppError(
        "Empresa não identificada. Selecione uma empresa para continuar.",
        400,
        "BUSINESS_NOT_IDENTIFIED",
      );
    }

    assertTenantAccess(findUser, resolvedBusinessId);

    // The company's zone (decision 1.1): the period's days, the day in the
    // file name and the hour in "Entregue em", which the server's zone (UTC)
    // put a day ahead from 21:00 in São Paulo.
    const findBusiness =
      await this.business.findBusinessById(resolvedBusinessId);
    const timeZone = resolveTimeZone(
      (findBusiness as { timezone?: string | null } | null)?.timezone,
    );

    const window = deliveryPeriodWindow({ period, from, to }, timeZone);

    // The listing's filters, so the file is what the screen shows (decision
    // 5.8). A driver exporting gets their own work, as their listing does.
    const iterator = this.delivery.streamDeliveriesForExport({
      businessId: resolvedBusinessId,
      scopeDriverId: findUser.driverId ?? undefined,
      search,
      statuses,
      shipperIds,
      driverIds,
      kinds,
      createdFrom: window?.start,
      createdTo: window?.end,
    });

    const columns: ExportColumn[] = [
      {
        header: "ID",
        key: "id",
        width: 38,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Pedido",
        key: "code",
        width: 18,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Chave da NF-e",
        key: "invoice_key",
        width: 46,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Número da NF",
        key: "invoice_number",
        width: 14,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Status",
        key: "status",
        width: 14,
        formatter: ExportFormatters.fallback,
      },
      // Meeting of 14/10/2026: "Entrega" / "Ordem de serviço" / "Coleta".
      // After Status, so the columns before it keep their place.
      {
        header: "Tipo",
        key: "kind",
        width: 18,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Destinatário",
        key: "recipient_name",
        width: 32,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Documento",
        key: "recipient_document",
        width: 20,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Telefone",
        key: "recipient_telephone",
        width: 18,
        formatter: ExportFormatters.phone,
      },
      {
        header: "Logradouro",
        key: "street",
        width: 32,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Número",
        key: "address_number",
        width: 10,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Bairro",
        key: "neighborhood",
        width: 20,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Cidade",
        key: "city",
        width: 24,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "UF",
        key: "uf",
        width: 6,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "CEP",
        key: "cep",
        width: 12,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Embarcador",
        key: "shipperName",
        width: 28,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Motorista",
        key: "driverName",
        width: 28,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Veículo",
        key: "vehiclePlate",
        width: 12,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Rota",
        key: "routeCode",
        width: 10,
        formatter: ExportFormatters.fallback,
      },
      // A civil day (decision 1.3): read as the day it stores, never shifted
      // by the process's zone like the instant columns.
      {
        header: "Data prevista",
        key: "scheduled_date",
        width: 16,
        formatter: (value) => formatDateOnlyBR(value as Date | string | null),
      },
      {
        header: "Entregue em",
        key: "delivered_at",
        width: 20,
        formatter: (value) => formatInstant(value, timeZone),
      },
      {
        header: "Recebido por",
        key: "received_by",
        width: 24,
        formatter: ExportFormatters.fallback,
      },
      {
        header: "Observações",
        key: "notes",
        width: 40,
        formatter: ExportFormatters.fallback,
      },
    ];

    const today = businessDateKey(new Date(), timeZone);

    return { iterator, columns, filename: `entregas-${today}` };
  }
}

export { ExportDeliveryUseCase };
export { DELIVERY_STATUS_LABELS };
