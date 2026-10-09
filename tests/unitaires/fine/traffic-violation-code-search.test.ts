import { describe, expect, it } from "vitest";

import { SearchTrafficViolationCodeCursorUseCase } from "@/modules/fine/usecases/search-traffic-violation-code-cursor/search-traffic-violation-code-cursor-usecase";
import { InMemoryTrafficViolationCodeRepository } from "@/modules/fine/repositories/in-memory/in-memory-traffic-violation-code-repository";
import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import type { User } from "@/modules/user/dtos/user-dto";

/**
 * The code picker of the fine form, searched on the server (FLEET-SEARCH-1,
 * CRIT-17). The use case used to drop the typed term: the national table
 * has hundreds of codes, and one not yet scrolled into view "did not exist".
 * The same search over Postgres is proven in tests/E2E/fine-http.test.ts.
 */
const USER = "018f0000-0000-7000-8000-0000000000a1";

function context() {
  const users = new InMemoryUserRepository();
  const codes = new InMemoryTrafficViolationCodeRepository();

  users.user.push({ id: USER, role: "BUSINESS_ADMIN", businessId: "b" } as User);

  // Twenty filler codes before the one searched for, so it is off the first page.
  for (let index = 0; index < 20; index += 1) {
    codes.add({
      code: String(500 + index),
      sub_code: 0,
      description: `Infração ${index}`,
      legal_basis: "CTB",
      violator_type: "Condutor",
      gravity: "LIGHT",
      gravity_raw: "Leve",
      points: 3,
      competent_agency: "Estadual",
    });
  }

  const wanted = codes.add({
    code: "745",
    sub_code: 50,
    description: "Transitar em velocidade superior à máxima permitida",
    legal_basis: "Art. 218, I",
    violator_type: "Condutor",
    gravity: "MEDIUM",
    gravity_raw: "Média",
    points: 4,
    competent_agency: "Municipal/Rodoviário",
  });

  return {
    wanted,
    useCase: new SearchTrafficViolationCodeCursorUseCase(users, codes),
  };
}

describe("searching traffic violation codes", () => {
  it("finds a code that is not on the first page", async () => {
    const { wanted, useCase } = context();

    const result = await useCase.execute({ userId: USER, limit: 10, search: "velocidade" });

    expect(result.data.map((code) => code.id)).toEqual([wanted.id]);
    expect(result.hasMore).toBe(false);
  });

  it("finds the code as printed on the notice", async () => {
    const { wanted, useCase } = context();

    const result = await useCase.execute({ userId: USER, limit: 10, search: "745-50" });

    expect(result.data.map((code) => code.fullCode)).toEqual(["745-50"]);
    expect(result.data[0].id).toBe(wanted.id);
  });

  it("without a term pages the whole table in code order", async () => {
    const { useCase } = context();

    const first = await useCase.execute({ userId: USER, limit: 10 });
    const second = await useCase.execute({
      userId: USER,
      limit: 10,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.data).toHaveLength(10);
    expect(first.hasMore).toBe(true);
    expect(second.data[0].code).toBe("510");
  });
});
