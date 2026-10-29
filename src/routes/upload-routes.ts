import { FastifyInstance } from "fastify";

import { CreatePresignedUploadController } from "@/modules/upload/usecases/create-presigned-upload/create-presigned-upload-controller";
import { CreatePresignedAvatarUploadController } from "@/modules/upload/usecases/create-presigned-upload/create-presigned-avatar-upload-controller";

import { LocalUploadController } from "@/modules/upload/usecases/create-presigned-upload/local-upload-controller";
import { uploadConfig } from "@/config/upload";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyBusinessActive } from "@/modules/middlewares/verify-tenant-active";

import {
  uploadSchemas,
  uploadResponses,
} from "./documentation/upload-documentation";

const createPresignedUploadController = new CreatePresignedUploadController();
const createPresignedAvatarUploadController =
  new CreatePresignedAvatarUploadController();

const localUploadController = new LocalUploadController();

async function uploadRoutes(app: FastifyInstance) {
  app.post(
    "/presign/:businessId",
    {
      onRequest: [ensureAuthenticated],

      // No `verifyPermission` here on purpose. Signing a URL creates nothing:
      // the key only becomes a record when the business endpoint accepts it,
      // and THAT endpoint already checks the permission for its own resource.
      // Gating here would mean listing every permission that might later use
      // an upload, and getting that list wrong in either direction.
      preHandler: [verifyBusinessActive],

      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["upload"],
        summary: "Autoriza um envio direto ao armazenamento",
        description:
          "Devolve um PUT assinado e de vida curta por arquivo, para o cliente enviar direto ao bucket sem passar os bytes pela API. A chave do objeto é gerada no servidor, dentro do prefixo da empresa; Content-Type e Content-Length fazem parte da assinatura, então o próprio armazenamento recusa um arquivo diferente do autorizado. Toda recusa traz o `code`.",
        params: uploadSchemas.businessIdParam,
        body: uploadSchemas.createPresignedUpload,
        response: {
          201: uploadResponses.presignedUploadCreated,
          400: uploadResponses.createPresignedUploadErrors,
          403: uploadResponses.serverOnlyUploadType,
          500: uploadResponses.internalServerError,
          503: uploadResponses.storageUnavailable,
        },
      },
    },
    createPresignedUploadController.handle,
  );

  app.post(
    "/avatar/presign",
    {
      onRequest: [ensureAuthenticated],

      // No tenant param and no `verifyBusinessActive`: an avatar belongs to a
      // person, not to a company, and a MASTER user may have no business at
      // all. The key is namespaced by the caller's own id instead.
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["upload"],
        summary: "Autoriza o envio direto de um avatar",
        description:
          "Igual ao envio da empresa, mas do usuário autenticado: a chave fica no prefixo do id do usuário, então o avatar não depende de empresa. Content-Type e Content-Length fazem parte da assinatura, então o próprio armazenamento recusa um arquivo diferente do autorizado. Toda recusa traz o `code`.",
        body: uploadSchemas.createPresignedAvatarUpload,
        response: {
          201: uploadResponses.presignedUploadCreated,
          400: uploadResponses.createPresignedUploadErrors,
          500: uploadResponses.internalServerError,
          503: uploadResponses.storageUnavailable,
        },
      },
    },
    createPresignedAvatarUploadController.handle,
  );

  // Development only: stands in for the bucket so localhost runs the same
  // client flow as production. The controller 404s when storage is R2.
  if (uploadConfig.storage.type !== "r2") {
    app.put(
      "/local",
      {
        schema: {
          tags: ["upload"],
          summary: "Recebe um envio direto quando o armazenamento é local",
          description:
            "Substituto do bucket em desenvolvimento. Recebe os bytes da imagem com o token assinado do presign; chave, tipo e tamanho vêm do token, com os mesmos limites de um PUT assinado no R2. Não é registrada com UPLOAD_STORAGE_TYPE=r2.",
          hide: true,
        },
      },
      localUploadController.handle,
    );
  }
}

export { uploadRoutes };
