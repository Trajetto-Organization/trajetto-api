import { FastifyReply, FastifyRequest } from "fastify";

import fs from "node:fs";
import path from "node:path";

import { uploadConfig } from "@/config/upload";
import { verifyLocalUploadToken } from "@/shared/services/local-upload-token";

import { AppError } from "@/shared/errors/AppError";

/**
 * Receives a direct upload when storage is local.
 *
 * This is what the bucket does in production, done here so development runs the
 * same client code instead of a second, untested path. It enforces exactly what
 * R2 enforces on a presigned PUT: the key, the content type and the byte count
 * all come from the signed token, never from the request, so a client cannot
 * write somewhere else or send something other than what was authorised.
 *
 * Unauthenticated by design, like the R2 endpoint it stands in for — the token
 * is the authorisation, and it is short lived.
 */
class LocalUploadController {
  async handle(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (uploadConfig.storage.type === "r2") {
      return reply.status(404).send({ message: "Rota não encontrada." });
    }

    const { token } = request.query as { token?: string };

    if (!token) {
      throw new AppError(
        "Token de upload ausente.",
        400,
        "UPLOAD_TOKEN_INVALID",
      );
    }

    const claims = verifyLocalUploadToken(token);
    const body = request.body;

    if (!Buffer.isBuffer(body)) {
      throw new AppError(
        "O corpo da requisição deve ser o conteúdo binário do arquivo.",
        400,
        "UPLOAD_BODY_INVALID",
      );
    }

    // R2 rejects a PUT whose length does not match the signature. Matching that
    // here is what keeps the size limit meaningful in development.
    if (body.length !== claims.size) {
      throw new AppError(
        "O tamanho do arquivo não corresponde ao autorizado.",
        400,
        "UPLOAD_SIZE_MISMATCH",
      );
    }

    const contentType = request.headers["content-type"];

    if (contentType !== claims.contentType) {
      throw new AppError(
        "O tipo do arquivo não corresponde ao autorizado.",
        400,
        "UPLOAD_CONTENT_TYPE_MISMATCH",
      );
    }

    const fullPath = path.join(uploadConfig.storage.localPath, claims.key);

    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.promises.writeFile(fullPath, body);

    return reply.status(200).send();
  }
}

export { LocalUploadController };
