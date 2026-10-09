import { describe, expect, it } from "vitest";

import { ListShipperUseCase } from "@/modules/shipper/usecases/list-shipper/list-shipper-usecase";
import { SearchShipperCursorUseCase } from "@/modules/shipper/usecases/search-shipper-cursor/search-shipper-cursor-usecase";
import { ListOccurrenceTypeUseCase } from "@/modules/occurrence-type/usecases/list-occurrence-type/list-occurrence-type-usecase";
import { ListStatusChangeReasonUseCase } from "@/modules/status-change-reason/usecases/list-status-change-reason/list-status-change-reason-usecase";
import { ListImportsUseCase } from "@/modules/import/usecases/list-imports/list-imports-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { InMemoryShipperRepository } from "@/modules/shipper/repositories/in-memory/in-memory-shipper-repository";
import { InMemoryOccurrenceTypeRepository } from "@/modules/occurrence-type/repositories/in-memory/in-memory-occurrence-type-repository";
import { InMemoryStatusChangeReasonRepository } from "@/modules/status-change-reason/repositories/in-memory/in-memory-status-change-reason-repository";
import { InMemoryImportRepository } from "@/modules/import/repositories/in-memory/in-memory-import-repository";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * The catalog lists' "not found" answers (decision 11.3: 404 with a code).
 *
 * The caller's own row can vanish between the auth hook and the use case (a
 * user deleted mid-session). That was a code-less ResourceNotFoundError the
 * controllers turned into a 400, and a MASTER's unknown company in the picker
 * a 400 too. Both are AppErrors now, answered by the global handler as they
 * are.
 */
const BUSINESS = "018f0000-0000-7000-8000-0000000009b1";
const GONE = "018f0000-0000-7000-8000-0000000009a9";
const MASTER = "018f0000-0000-7000-8000-0000000009a1";

const PAGE = { page: 1, pageSize: 10 } as const;

const USER_NOT_FOUND = { statusCode: 404, code: "USER_NOT_FOUND" };

describe("a catalog list asked by a user who no longer exists", () => {
  const users = new InMemoryUserRepository();

  it.each([
    [
      "the shippers tab",
      () =>
        new ListShipperUseCase(users, new InMemoryShipperRepository()).execute({
          userId: GONE,
          businessId: BUSINESS,
          ...PAGE,
        }),
    ],
    [
      "the shipper picker",
      () =>
        new SearchShipperCursorUseCase(
          users,
          new InMemoryShipperRepository(),
          new InMemoryBusinessRepository(),
        ).execute({ userId: GONE, businessId: BUSINESS }),
    ],
    [
      "the occurrence types tab",
      () =>
        new ListOccurrenceTypeUseCase(users, new InMemoryOccurrenceTypeRepository()).execute({
          userId: GONE,
          businessId: BUSINESS,
          ...PAGE,
        }),
    ],
    [
      "the status change reasons tab",
      () =>
        new ListStatusChangeReasonUseCase(
          users,
          new InMemoryStatusChangeReasonRepository(),
        ).execute({ userId: GONE, businessId: BUSINESS, ...PAGE }),
    ],
    [
      "the imports tab",
      () =>
        new ListImportsUseCase(users, new InMemoryImportRepository()).execute({
          userId: GONE,
          businessId: BUSINESS,
          ...PAGE,
        }),
    ],
  ])("%s answers 404 USER_NOT_FOUND", async (_tab, run) => {
    await expect(run()).rejects.toMatchObject(USER_NOT_FOUND);
  });
});

describe("the shipper picker asked by a MASTER for a company that does not exist", () => {
  it("answers 404 TENANT_NOT_FOUND, the route guard's code", async () => {
    const users = new InMemoryUserRepository();

    users.user.push({ id: MASTER, role: "MASTER", businessId: null } as unknown as User);

    const picker = new SearchShipperCursorUseCase(
      users,
      new InMemoryShipperRepository(),
      new InMemoryBusinessRepository(),
    );

    await expect(
      picker.execute({ userId: MASTER, businessId: BUSINESS }),
    ).rejects.toMatchObject({ statusCode: 404, code: "TENANT_NOT_FOUND" });
  });
});
