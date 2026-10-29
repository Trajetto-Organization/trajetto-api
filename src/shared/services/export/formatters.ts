const ExportFormatters = {
  currency(value?: number) {
    if (value === null || value === undefined) return "N/A";

    return value.toLocaleString("pt-BR", {
      style: "currency",
      currency: "BRL",
    });
  },

  number3(value?: number) {
    if (value === null || value === undefined) return "0,000";

    return value.toLocaleString("pt-BR", {
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
  },

  booleanSimNao(value?: boolean) {
    if (value === null || value === undefined) return "Não";
    return value ? "Sim" : "Não";
  },

  // No date formatters here on purpose: a date column needs the company's
  // zone, which a shared, argument-less formatter cannot know (it printed in
  // the process's zone, UTC in the container). Use formatPickedDay /
  // formatInstant from shared/vehicle/record-dates with Business.timezone, or
  // formatDateOnlyBR for a date-only column.

  cpf: (value: any): string => {
    if (!value) return "N/A";

    const cpf = String(value).replace(/\D/g, "");
    return cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4");
  },

  cnpj: (value: any): string => {
    if (!value) return "N/A";

    const cnpj = String(value).replace(/\D/g, "");
    return cnpj.replace(
      /(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/,
      "$1.$2.$3/$4-$5",
    );
  },

  phone: (value: any): string => {
    if (!value) return "N/A";
    const phone = String(value).replace(/\D/g, "");

    if (phone.length === 11) {
      return phone.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
    } else if (phone.length === 10) {
      return phone.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
    }

    return value;
  },

  formatCondition: (condition: string | null | undefined): string => {
    if (!condition) return "N/A";

    const conditionMap: Record<string, string> = {
      approved: "Aprovado",
      approved_with_restrictions: "Aprovado com Restrições",
      rejected: "Rejeitado",
      good: "Boa",
      fair: "Regular",
      poor: "Ruim",
      bad: "Ruim",
      needs_attention: "Precisa de Atenção",
    };

    return conditionMap[condition] || condition;
  },

  vehicleChecklistFallback(value?: boolean) {
    if (value) return "OK";
    return "NOK";
  },

  fallback(value?: string | number | null) {
    if (value === null || value === undefined || value === "") return "N/A";
    return value;
  },
};

export { ExportFormatters };
