import { z } from "zod";

import {
  createPresignedUploadSchema,
  presignedUploadFilesSchema,
} from "@/schemas/create-presigned-upload-schema";
import { updateDeleteBusinessSchema } from "@/schemas/update-delete-business-schema";

import { errorResponse } from "./common-responses";

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

  createPresignedUploadErrors: errorResponse.describe(
    "VALIDATION_ERROR (corpo recusado; issues diz qual), UNSUPPORTED_FILE_TYPE (tipo de arquivo não aceito para este envio) ou FILE_TOO_LARGE (tamanho acima do limite do tipo de envio).",
  ),
  internalServerError: z.object({
    message: z.string(),
  }),
  serverOnlyUploadType: errorResponse.describe(
    "SERVER_ONLY_UPLOAD_TYPE: este tipo de envio é gerado só pelo servidor (ex.: comprovantes assinados) e não aceita PUT do cliente.",
  ),
  storageUnavailable: errorResponse.describe(
    "STORAGE_UNAVAILABLE: o armazenamento de arquivos está fora do ar. Tente de novo em instantes.",
  ),
};

export { uploadSchemas, uploadResponses };
