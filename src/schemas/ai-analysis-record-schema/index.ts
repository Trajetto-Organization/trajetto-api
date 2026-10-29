import { z } from "zod";

const aiAnalysisRecordSchema = z.object({
  recordType: z.enum(["fuel", "checklist"], {
    errorMap: () => ({
      message: "Tipo de registro inválido. Deve ser fuel ou checklist.",
    }),
  }),
  recordId: z.string().uuid("ID do registro é inválido."),
});

export { aiAnalysisRecordSchema };
