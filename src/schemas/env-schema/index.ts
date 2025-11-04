import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3333),
  RABBITMQ_URL: z.string(),
  OSRM_URL: z.string(),
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

  // File Upload Configuration
  UPLOAD_STORAGE_TYPE: z.enum(["local", "r2"]).default("local"),
  UPLOAD_LOCAL_PATH: z.string().default("./tmp"),

  // Cloudflare R2 Configuration
  R2_ACCOUNT_ID: z.string().optional(),
  R2_BUCKET_NAME: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_PUBLIC_DOMAIN: z.string().optional(),
});

export { envSchema };
