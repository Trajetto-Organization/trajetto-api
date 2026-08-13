import { z } from "zod";

// Mirrors `UploadType` in config/upload.ts. Kept as an explicit enum so an
// unknown value is rejected by the schema instead of reaching the service and
// indexing the size-limit table with `undefined`.
const uploadTypeSchema = z.enum([
  "odometerPhotos",
  "avatars",
  "checklistPhotos",
]);

const presignedUploadFileSchema = z.object({
  originalFilename: z
    .string()
    .min(1, "O nome do arquivo é obrigatório!")
    .max(255, "O nome do arquivo deve ter no máximo 255 caracteres."),

  contentType: z
    .string()
    .min(1, "O tipo do arquivo é obrigatório!")
    .describe("MIME type real do arquivo, usado na assinatura"),

  // Signed into the URL, so it has to be the exact byte count the client will
  // send — R2 rejects the PUT otherwise. The upper bound here is a cheap first
  // filter; the authoritative limit per upload type lives in the service.
  size: z
    .number({ required_error: "O tamanho do arquivo é obrigatório!" })
    .int("O tamanho deve ser um número inteiro de bytes.")
    .positive("O tamanho deve ser maior que zero.")
    .max(50 * 1024 * 1024, "Arquivo muito grande."),
});

const presignedUploadFilesSchema = z.object({
  // Batched because a checklist asks for every photo at once — one round trip
  // instead of twenty.
  files: z
    .array(presignedUploadFileSchema)
    .min(1, "Envie ao menos um arquivo.")
    .max(20, "No máximo 20 arquivos por solicitação."),
});

// The avatar endpoint has no `uploadType`: it only ever signs avatars, and the
// scope comes from the authenticated user rather than the body.
const createPresignedUploadSchema = presignedUploadFilesSchema.extend({
  uploadType: uploadTypeSchema,
});

export {
  createPresignedUploadSchema,
  presignedUploadFilesSchema,
  uploadTypeSchema,
};
