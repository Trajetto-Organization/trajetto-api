import { describe, expect, it } from "vitest";

import { GetImportUseCase } from "@/modules/import/usecases/get-import/get-import-usecase";

import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * Opening one spreadsheet upload: the company is in the read itself, so
 * another carrier's upload reads exactly like a missing one, and a company
 * user naming another company is refused before any read.
 */
const A = "018f0000-0000-7000-8000-00000000000a";
const B = "018f0000-0000-7000-8000-00000000000b";
const ADMIN_A = "018f0000-0000-7000-8000-0000000000a1";
const ADMIN_B = "018f0000-0000-7000-8000-0000000000b1";
const MASTER = "018f0000-0000-7000-8000-0000000000f1";
const GHOST = "018f0000-0000-7000-8000-0000000000ff";

async function makeContext() {
  const users = new InMemoryUserRepository();
  const imports = new InMemoryImportRepository();

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, role: "MASTER", businessId: null } as User,
  );

  const upload = await imports.createImport({
    source: "SPREADSHEET",
    filename: "entregas-06-10.xlsx",
    businessId: A,
    performedById: ADMIN_A,
  } as never);

  return { upload, imports, get: new GetImportUseCase(users, imports) };
}

describe("opening an import", () => {
  it("returns the company's own upload, to its users and to the MASTER", async () => {
    const { upload, get } = await makeContext();

    await expect(
      get.execute({ userId: ADMIN_A, businessId: A, importId: upload.id }),
    ).resolves.toMatchObject({
      id: upload.id,
      filename: "entregas-06-10.xlsx",
    });
    await expect(
      get.execute({ userId: MASTER, businessId: A, importId: upload.id }),
    ).resolves.toMatchObject({
      id: upload.id,
    });
  });

  it("reads another company's upload exactly like a missing one", async () => {
    const { upload, get } = await makeContext();

    const foreign = await get
      .execute({ userId: ADMIN_B, businessId: B, importId: upload.id })
      .catch((error) => error);
    const missing = await get
      .execute({ userId: ADMIN_B, businessId: B, importId: GHOST })
      .catch((error) => error);

    expect(foreign).toMatchObject({ statusCode: 404 });
    expect(missing).toMatchObject({
      statusCode: 404,
      code: foreign.code,
      message: foreign.message,
    });
  });

  it("refuses another company's id from a company user, and an unknown caller", async () => {
    const { upload, get } = await makeContext();

    await expect(
      get.execute({ userId: ADMIN_B, businessId: A, importId: upload.id }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(
      get.execute({ userId: GHOST, businessId: A, importId: upload.id }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });

  it("lets a repository failure reach the caller (the handler answers 500), never a 404", async () => {
    // Swallowed into "not found", an outage would tell the user the upload
    // is gone.
    const { upload, imports, get } = await makeContext();

    imports.findImportById = async () => {
      throw new Error("connection reset");
    };

    await expect(
      get.execute({ userId: ADMIN_A, businessId: A, importId: upload.id }),
    ).rejects.toThrow("connection reset");
  });
});
