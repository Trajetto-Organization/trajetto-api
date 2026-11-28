import { describe, expect, it } from "vitest";

import { ListRoutesUseCase } from "@/modules/route/usecases/list-routes/list-routes-usecase";
import { InMemoryRouteRepository } from "@/modules/route/repositories/in-memory/in-memory-route-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryBusinessRepository } from "@/modules/business/repositories/in-memory/in-memory-business-repository";
import { BUSINESS_COLUMN_DEFAULTS } from "@/shared/in-memory/column-defaults";

import type { User } from "@/modules/user/dtos/user-dto";
import type { Business } from "@/modules/business/dtos/business-dto";

/**
 * The routes board shows Previsto, Saída and Conclusão as hours. Read on the
 * browser's clock, a dispatcher in another zone than the company's (or a
 * MASTER looking at a company in Manaus from São Paulo) saw hours that
 * disagree with the route's own page, which reads the company's zone from
 * get-route's meta.timeZone (G8). The listing's meta line carries the same
 * zone, so the board can use it (reported by the web's G4 work).
 */
const MANAUS_CARRIER = "018f0000-0000-7000-8000-00000000c0a1";
const NO_ROW_CARRIER = "018f0000-0000-7000-8000-00000000c0a2";

const MANAGER = "018f0000-0000-7000-8000-00000000c1a1";
const OTHER_MANAGER = "018f0000-0000-7000-8000-00000000c1a2";

function build() {
  const users = new InMemoryUserRepository();
  const businesses = new InMemoryBusinessRepository();

  users.user.push(
    {
      id: MANAGER,
      role: "BUSINESS_ADMIN",
      businessId: MANAUS_CARRIER,
    } as User,
    {
      id: OTHER_MANAGER,
      role: "BUSINESS_ADMIN",
      businessId: NO_ROW_CARRIER,
    } as User,
  );

  businesses.business.push({
    ...BUSINESS_COLUMN_DEFAULTS,
    id: MANAUS_CARRIER,
    is_active: true,
    timezone: "America/Manaus",
  } as Business);

  return new ListRoutesUseCase(
    new InMemoryRouteRepository(),
    users,
    businesses,
  );
}

describe("the routes listing's zone", () => {
  it("is the company's, for the board's hours", async () => {
    const result = await build().execute({
      userId: MANAGER,
      page: 1,
      pageSize: 10,
    });

    expect(result.meta.timeZone).toBe("America/Manaus");
  });

  it("falls back to the platform's default zone, never the browser's", async () => {
    const result = await build().execute({
      userId: OTHER_MANAGER,
      page: 1,
      pageSize: 10,
    });

    expect(result.meta.timeZone).toBe("America/Sao_Paulo");
  });
});
