import { AccountPayableStatus } from "@/modules/account-payable/dtos/account-payable-dto";
import { VehicleStatus } from "@prisma/client";

const formatDate = (date: string | Date, locale: string): string => {
  return new Date(date).toLocaleDateString(locale);
};

const formatNotificationDate = (
  date: Date | string,
  locale: string = "pt-BR",
): string => {
  try {
    const dateObject = typeof date === "string" ? new Date(date) : date;

    return new Intl.DateTimeFormat(locale, {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })
      .format(dateObject)
      .replace(",", " às");
  } catch (error) {
    return String(date);
  }
};

const formatTelephone = (telephone: string): string => {
  return telephone.replace(/^(\d{2})(\d{5}|\d{4})(\d{4})$/, "+55 ($1) $2-$3");
};

const formatCnpj = (cnpj: string): string => {
  return cnpj.replace(
    /^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/,
    "$1.$2.$3/$4-$5",
  );
};

const formatCep = (cep: string): string => {
  return cep.replace(/^(\d{5})(\d{3})$/, "$1-$2");
};

const formatCpf = (cpf: string): string => {
  return cpf.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, "$1.$2.$3-$4");
};

const formatRg = (rg: string): string => {
  const digits = rg.replace(/\D/g, "");

  if (/^\d{9}$/.test(digits)) {
    return digits.replace(/^(\d{2})(\d{3})(\d{3})(\d)$/, "$1.$2.$3-$4");
  }

  return rg;
};

const formatCurrency = (value: number): string => {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
};

const vehicleStatusTranslation: Record<VehicleStatus, string> = {
  ACTIVE: "Ativo",
  INACTIVE: "Inativo",
  BLOCKED: "Bloqueado",
  IN_ROUTE: "Em Rota",
};

const accountPayableStatusTranslation: Record<AccountPayableStatus, string> = {
  PENDING: "Pendente",
  PAID: "Pago",
  PARTIAL: "Parcial",
  LATE: "Pago com atraso",
  PARTIAL_LATE: "Parcial com atraso",
  OVERDUE: "Vencido",
};

const translateAccountPayableStatus = (
  status: AccountPayableStatus,
): string => {
  return accountPayableStatusTranslation[status];
};

const translateVehicleStatus = (status: VehicleStatus): string => {
  return vehicleStatusTranslation[status];
};

const formatServiceOrderDisplay = (serviceOrder: any) => {
  // Format the date in a readable way
  const formattedDate =
    formatDate(serviceOrder.date, "pt-BR") || serviceOrder.date;

  // Get vehicle info if available
  const vehicleInfo = serviceOrder.vehicle.license_plate
    ? `(Veículo: ${serviceOrder.vehicle.description || ""} - Placa: ${serviceOrder.vehicle.license_plate})`
    : "";

  // Combine ID and date for a unique display
  return `OS#${serviceOrder.id.slice(-12)} - ${formattedDate} ${vehicleInfo}`;
};

export {
  formatDate,
  formatTelephone,
  formatCnpj,
  formatCep,
  formatCpf,
  formatRg,
  formatCurrency,
  translateVehicleStatus,
  formatNotificationDate,
  translateAccountPayableStatus,
  formatServiceOrderDisplay,
};
