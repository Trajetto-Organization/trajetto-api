import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().default(3333),
  RABBITMQ_URL: z.string(),
  HTTP_REQUEST: z.string(),
  API_HTTP_REQUEST: z.string().optional(),
  JWT_SECRET: z.string(),
  JWT_SECRET_REFRESH_TOKEN: z.string(),
  CLOUDINARY_LOGO_IMAGE: z.string(),
  EVOLUTION_API_URL: z.string(),
  EVOLUTION_API_KEY: z.string(),
  EVOLUTION_HTTP_REQUEST: z.string().optional(),
  RESEND_SECRET_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.string().optional(),
});

export { envSchema };
