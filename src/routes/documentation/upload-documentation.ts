import { z } from "zod";

import {
  createPresignedUploadSchema,
  presignedUploadFilesSchema,
} from "@/schemas/create-presigned-upload-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

const uploadSchemas = {
  createPresignedUpload: createPresignedUploadSchema,
  createPresignedAvatarUpload: presignedUploadFilesSchema,
  businessIdParam: updateDeleteBusinessSchema,
};

const uploadResponses = {
  presignedUploadCreated: z.object({
    uploads: z.array(
      z.object({
        key: z
          .string()
          .describe(
            "Chave do objeto no bucket. É este valor que deve ser enviado ao endpoint de negócio, nunca a URL.",
          ),
        uploadUrl: z
          .string()
          .describe(
            "URL assinada para PUT direto. O cliente deve enviar os cabeçalhos Content-Type e Content-Length exatamente como declarados.",
          ),
        expiresIn: z
          .number()
          .describe("Validade da URL em segundos, a partir da emissão."),
      }),
    ),
  }),

  createPresignedUploadErrors: z.object({
    message: z
      .string()
      .describe(
        "Tipo de arquivo não suportado, tamanho acima do limite do tipo de upload, ou armazenamento direto indisponível.",
      ),
  }),

  internalServerError: z.object({
    message: z.string(),
  }),
};

export { uploadSchemas, uploadResponses };
