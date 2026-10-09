import { z } from "zod";

import { BRAZILIAN_TIME_ZONES } from "@/shared/time/business-day";

/**
 * The company's time zone (decision 1.1): one of Brazil's IANA zones, so a
 * typo cannot move every "today" of the company. The web mirrors the list
 * with pt-BR labels (trajetto-ui src/app/(protected)/_components/admin/business/timezone-field/timezones.ts).
 */
const businessTimezoneField = z
  .enum(BRAZILIAN_TIME_ZONES, {
    errorMap: () => ({
      message: "Fuso horário inválido. Escolha um dos fusos do Brasil.",
    }),
  })
  .describe(
    `Fuso horário da empresa (IANA), um dos fusos do Brasil: ${BRAZILIAN_TIME_ZONES.join(", ")}. Define o "hoje" de todos os painéis e relatórios. Ausente no cadastro, America/Sao_Paulo.`,
  );

export { businessTimezoneField };
