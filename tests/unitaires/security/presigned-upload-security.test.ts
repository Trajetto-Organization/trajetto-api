import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

import { UploadService } from "@/shared/services/upload-service";
import { AppError } from "@/shared/errors/AppError";
import type { UploadType } from "@/config/upload";

const COMPANY_A = "0198a8d0-70c0-7000-8000-00000000000a";
const COMPANY_B = "0198a8d0-70c0-7000-8000-00000000000b";

const USER_A = "0198a8d0-70c0-7000-8000-0000000000a1";
const USER_B = "0198a8d0-70c0-7000-8000-0000000000b1";

/**
 * With a presigned upload the bytes never reach the API: the client PUTs
 * straight to R2 and hands back only the object key. That moves a guarantee
 * that used to be implicit — you could only write what you had just parsed —
 * onto `resolvePresignedUploads`, which is now the single thing standing
 * between a client and another tenant's files.
 *
 * `headUploadedObject` is stubbed because it talks to R2. What matters here is
 * whether the key is rejected before it ever gets that far.
 */
describe("presigned upload key isolation", () => {
  let service: UploadService;
  let head: MockInstance<
    [key: string, uploadType: UploadType],
    Promise<{ size: number; contentType: string }>
  >;

  beforeEach(() => {
    service = new UploadService();

    head = vi
      .spyOn(service, "headUploadedObject")
      .mockResolvedValue({ size: 1024, contentType: "image/webp" });
  });

  it("accepts a key under the caller's own prefix", async () => {
    const resolved = await service.resolvePresignedUploads(
      [
        {
          key: `checklistPhotos/${COMPANY_A}/123-photo-abc.webp`,
          fieldName: "tires",
        },
      ],
      "checklistPhotos",
      COMPANY_A,
    );

    expect(resolved).toEqual([
      {
        path: `checklistPhotos/${COMPANY_A}/123-photo-abc.webp`,
        fieldName: "tires",
      },
    ]);
  });

  it("rejects a key that belongs to another company", async () => {
    await expect(
      service.resolvePresignedUploads(
        [{ key: `checklistPhotos/${COMPANY_B}/123-photo-abc.webp` }],
        "checklistPhotos",
        COMPANY_A,
      ),
    ).rejects.toMatchObject({ statusCode: 403, code: "UPLOAD_KEY_FORBIDDEN" });

    // Rejected on the prefix alone — no round trip to storage.
    expect(head).not.toHaveBeenCalled();
  });

  it("rejects a key from another upload type under the same company", async () => {
    await expect(
      service.resolvePresignedUploads(
        [{ key: `avatars/${COMPANY_A}/123-photo-abc.webp` }],
        "checklistPhotos",
        COMPANY_A,
      ),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects traversal attempts that start with a valid prefix", async () => {
    const keys = [
      `checklistPhotos/${COMPANY_A}/../${COMPANY_B}/stolen.webp`,
      `checklistPhotos/${COMPANY_A}//${COMPANY_B}/stolen.webp`,
      `checklistPhotos/${COMPANY_A}/..\\${COMPANY_B}\\stolen.webp`,
    ];

    for (const key of keys) {
      await expect(
        service.resolvePresignedUploads(
          [{ key }],
          "checklistPhotos",
          COMPANY_A,
        ),
      ).rejects.toMatchObject({ code: "UPLOAD_KEY_FORBIDDEN" });
    }

    expect(head).not.toHaveBeenCalled();
  });

  it("fails the whole batch when a single key is foreign", async () => {
    await expect(
      service.resolvePresignedUploads(
        [
          { key: `checklistPhotos/${COMPANY_A}/ok.webp` },
          { key: `checklistPhotos/${COMPANY_B}/stolen.webp` },
        ],
        "checklistPhotos",
        COMPANY_A,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_KEY_FORBIDDEN" });
  });

  it("scopes avatars by user, so one user cannot claim another's upload", async () => {
    await expect(
      service.resolvePresignedUploads(
        [{ key: `avatars/${USER_B}/123-face-abc.webp` }],
        "avatars",
        USER_A,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_KEY_FORBIDDEN" });

    await expect(
      service.resolvePresignedUploads(
        [{ key: `avatars/${USER_A}/123-face-abc.webp` }],
        "avatars",
        USER_A,
      ),
    ).resolves.toHaveLength(1);
  });

  it("does not let a prefix be spoofed by an id that merely starts the same", async () => {
    await expect(
      service.resolvePresignedUploads(
        [{ key: `checklistPhotos/${COMPANY_A}-evil/stolen.webp` }],
        "checklistPhotos",
        COMPANY_A,
      ),
    ).rejects.toMatchObject({ code: "UPLOAD_KEY_FORBIDDEN" });
  });
});
