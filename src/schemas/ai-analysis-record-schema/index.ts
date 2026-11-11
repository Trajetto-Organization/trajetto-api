import { z } from "zod";

const aiAnalysisRecordSchema = z.object({
  recordType: z.enum(["fuel", "checklist"], {
    error: "Tipo de registro inválido. Deve ser fuel ou checklist.",
  }),
  recordId: z.string().uuid("ID do registro é inválido."),
});

export { aiAnalysisRecordSchema };
