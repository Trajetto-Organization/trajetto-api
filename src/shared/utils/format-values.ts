import { VehicleStatus } from "@prisma/client";

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

const formatDate = (date: string | Date, locale: string): string => {
  return new Date(date).toLocaleDateString(locale);
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
