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
        summary: "Authorise a direct upload to storage",
        description:
          "Returns one short-lived signed PUT per file so the client uploads straight to the bucket, keeping the file bytes off the API. The object key is generated server-side and namespaced by business; Content-Type and Content-Length are part of the signature, so storage itself rejects a file that does not match what was authorised.",
        params: uploadSchemas.businessIdParam,
        body: uploadSchemas.createPresignedUpload,
        response: {
          201: uploadResponses.presignedUploadCreated,
          400: uploadResponses.createPresignedUploadErrors,
          500: uploadResponses.internalServerError,
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
        summary: "Authorise a direct avatar upload to storage",
        description:
          "Same as the business endpoint, but scoped to the authenticated user: the object key is namespaced by user id, so an avatar needs no tenant. Content-Type and Content-Length are part of the signature, so storage itself rejects a file that does not match what was authorised.",
        body: uploadSchemas.createPresignedAvatarUpload,
        response: {
          201: uploadResponses.presignedUploadCreated,
          400: uploadResponses.createPresignedUploadErrors,
          500: uploadResponses.internalServerError,
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
          summary: "Receive a direct upload when storage is local",
          description:
            "Development stand-in for the storage bucket. Accepts the raw image bytes with the signed token from the presign query string; the key, content type and length come from the token, so it enforces the same limits a presigned PUT to R2 would. Not registered when UPLOAD_STORAGE_TYPE is r2.",
          hide: true,
        },
      },
      localUploadController.handle,
    );
  }
}

export { uploadRoutes };
