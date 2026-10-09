import { VehicleStatus } from "@prisma/client";

import { resolveTimeZone } from "@/shared/time/business-day";
import { formatPickedDay } from "@/shared/vehicle/record-dates";

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

/**
 * "17/09/2026" for a timestamp that means a day, read in the company's zone
 * (decision 1.1). The process's zone is UTC in the container, which printed
 * the next day from 21:00 in São Paulo. A missing or unknown zone (an event
 * published before it carried one) reads in the platform's default.
 */
const formatDate = (
  date: string | Date,
  timeZone: string | null | undefined,
): string => {
  return formatPickedDay(date, resolveTimeZone(timeZone));
};

const vehicleStatusTranslation: Record<VehicleStatus, string> = {
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
  BLOCKED: "Bloqueado",
  IN_ROUTE: "Em Rota",
};

const translateVehicleStatus = (status: VehicleStatus): string => {
  return vehicleStatusTranslation[status];
};

export { formatCurrency, formatDate, translateVehicleStatus };
