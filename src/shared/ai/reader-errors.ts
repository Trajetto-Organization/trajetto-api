import { InvalidModelResponseError } from "./ai-answers";
import type { ProviderCallUsage } from "./ai-types";

/**
 * The photo could not be read from storage. Not the reader's failure, so it
 * never counts toward pausing the pipeline; a photo that does not exist
 * (ENOENT, NoSuchKey) will not appear on a retry and is permanent.
 */
class ImageUnavailableError extends Error {
  readonly permanent: boolean;

  constructor(storagePath: string, cause: unknown) {
    const code =
      cause && typeof cause === "object"
        ? String(
            (cause as { code?: unknown; name?: unknown }).code ??
              (cause as { name?: unknown }).name ??
              "",
          )
        : "";

    super(
      `Foto indisponível no armazenamento (${code || "erro"}): ${storagePath}`,
    );

    this.permanent = code === "ENOENT" || code === "NoSuchKey";
  }
}

/**
 * An answer that failed the schema, from a call that happened (and, for a
 * paid model, was billed): the attempt row keeps its usage.
 */
class PaidInvalidResponseError extends InvalidModelResponseError {
  constructor(
    message: string,
    readonly usage: ProviderCallUsage,
  ) {
    super("");
    this.message = message;
  }
}

export { ImageUnavailableError, PaidInvalidResponseError };
