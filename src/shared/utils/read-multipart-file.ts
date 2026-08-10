import type { MultipartFile } from "@fastify/multipart";

import { AppError } from "@/shared/errors/AppError";

interface ReadMultipartFileOptions {
  timeoutMs?: number;
  maxBytes?: number;
}

async function readMultipartFile(
  part: MultipartFile,
  { timeoutMs = 30_000, maxBytes }: ReadMultipartFileOptions = {},
): Promise<Buffer> {
  let timeout: NodeJS.Timeout | undefined;

  try {
    const buffer = await Promise.race([
      part.toBuffer(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          part.file.destroy(new Error("Multipart upload timed out"));
          reject(
            new AppError(
              "O upload demorou demais. Verifique a conexão e tente novamente.",
              408,
              "UPLOAD_TIMEOUT",
            ),
          );
        }, timeoutMs);
      }),
    ]);

    if (maxBytes !== undefined && buffer.length > maxBytes) {
      throw new AppError(
        "O arquivo excede o limite de tamanho permitido.",
        400,
        "UPLOAD_SIZE_LIMIT_EXCEEDED",
      );
    }

    return buffer;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export { readMultipartFile };
