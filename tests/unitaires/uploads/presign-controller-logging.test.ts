import "reflect-metadata";

import { afterEach, describe, expect, it, vi } from "vitest";
import { container } from "tsyringe";

import { CreatePresignedUploadController } from "@/modules/upload/usecases/create-presigned-upload/create-presigned-upload-controller";
import { CreatePresignedAvatarUploadController } from "@/modules/upload/usecases/create-presigned-upload/create-presigned-avatar-upload-controller";
import { AppError } from "@/shared/errors/AppError";

/**
 * OBS-12: the presign controllers caught everything that was not an AppError
 * and answered 500 without a word. The global error handler — the one place
 * that logs a stack — never saw it, so the access log showed a 500 and
 * nothing said why. The body stays the same; the cause now reaches the log.
 */
const BUSINESS = "018fe000-0000-7000-8000-0000000000ba";
const USER = "018fe000-0000-7000-8000-0000000000bb";

function request(body: unknown, params: Record<string, string> = {}) {
  return {
    user: { id: USER },
    params,
    body,
    headers: { host: "api.exemplo.com" },
    protocol: "https",
    log: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
}

interface ReplyStub {
  statusCode: number;
  payload: unknown;
  status: (code: number) => ReplyStub;
  send: (payload: unknown) => ReplyStub;
}

function reply(): ReplyStub {
  const stub: ReplyStub = {
    statusCode: 0,
    payload: undefined,
    status: (code) => {
      stub.statusCode = code;
      return stub;
    },
    send: (payload) => {
      stub.payload = payload;
      return stub;
    },
  };

  return stub;
}

function useCaseThatThrows(error: unknown) {
  vi.spyOn(container, "resolve").mockReturnValue({
    execute: async () => {
      throw error;
    },
  } as never);
}

const files = [
  { originalFilename: "foto.jpg", contentType: "image/jpeg", size: 1024 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a presign that fails for a reason nobody anticipated", () => {
  it("logs the cause on the business endpoint, and still answers 500", async () => {
    const boom = new Error("boom: S3 client exploded");
    useCaseThatThrows(boom);

    const req = request(
      { uploadType: "checklistPhotos", files },
      { businessId: BUSINESS },
    );
    const res = reply();

    await new CreatePresignedUploadController().handle(
      req as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    expect(res.payload).toEqual({
      message: "Não foi possível autorizar o upload.",
    });
    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, uploadType: "checklistPhotos" }),
      expect.any(String),
    );
  });

  it("logs the cause on the avatar endpoint", async () => {
    const boom = new Error("boom");
    useCaseThatThrows(boom);

    const req = request({ files });
    const res = reply();

    await new CreatePresignedAvatarUploadController().handle(
      req as never,
      res as never,
    );

    expect(res.statusCode).toBe(500);
    expect(req.log.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, uploadType: "avatars" }),
      expect.any(String),
    );
  });

  it("does not log an expected refusal as an error, and hands it to the handler with its code", async () => {
    const refusal = new AppError(
      "Tipo de arquivo não permitido.",
      400,
      "UPLOAD_TYPE_NOT_ALLOWED",
    );

    useCaseThatThrows(refusal);

    const req = request({ files });
    const res = reply();

    // Rethrown, not answered inline: the global handler sends `{ code,
    // message }` and `x-error-code` (decision 11.3). The inline answer
    // used to drop the code.
    await expect(
      new CreatePresignedAvatarUploadController().handle(
        req as never,
        res as never,
      ),
    ).rejects.toBe(refusal);

    expect(req.log.error).not.toHaveBeenCalled();
  });
});
