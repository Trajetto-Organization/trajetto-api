import { z } from "zod";

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().default(3333),
    RABBITMQ_URL: z.string(),
    REDIS_URL: z.string(),
    OSRM_URL: z.string().optional(),
    HTTP_REQUEST: z.string(),
    API_HTTP_REQUEST: z.string().optional(),
    JWT_SECRET: z.string(),
    JWT_SECRET_REFRESH_TOKEN: z.string(),
    CLOUDINARY_LOGO_IMAGE: z.string().optional(),
    EVOLUTION_API_URL: z.string(),
    EVOLUTION_API_KEY: z.string(),
    EVOLUTION_HTTP_REQUEST: z.string().optional(),
    TRAJETTO_WHATSAPP_BUSINESS_PHONE: z.string(),
    TRAJETTO_WHATSAPP_INSTANCE_NAME: z.string(),
    RESEND_SECRET_KEY: z.string().optional(),
    RESEND_FROM_EMAIL: z.string().optional(),
    MASTER_USER_EMAIL: z.string(),
    MASTER_USER_INITIAL_PASSWORD: z.string(),

    // File Upload Configuration
    UPLOAD_STORAGE_TYPE: z.enum(["local", "r2"]).default("local"),
    UPLOAD_LOCAL_PATH: z.string().default("./tmp"),

    // Cloudflare R2 Configuration
    R2_ACCOUNT_ID: z.string().optional(),
    R2_BUCKET_NAME: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    // Sem R2_PUBLIC_DOMAIN: o bucket e privado e todo acesso sai por URL
    // assinada de curta duracao (ver upload-service.getFileUrl). Um dominio
    // publico daria acesso permanente e sem assinatura as fotos.
    UPLOAD_SIGNED_URL_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(60)
      .max(3600)
      .default(900),

    // AI Verification (Claude Haiku Vision)
    ANTHROPIC_API_KEY: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;

    if (env.UPLOAD_STORAGE_TYPE !== "r2") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["UPLOAD_STORAGE_TYPE"],
        message:
          "Produção exige R2 privado; armazenamento local não é permitido para fotos sensíveis.",
      });
    }

    for (const field of [
      "R2_ACCOUNT_ID",
      "R2_BUCKET_NAME",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ] as const) {
      if (!env[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} é obrigatório em produção.`,
        });
      }
    }
  });

export { envSchema };
