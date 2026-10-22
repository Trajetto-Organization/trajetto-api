import { describe, expect, it } from "vitest";

import { InMemoryDriverPauseRepository } from "@/modules/driver-pause/repositories/in-memory/in-memory-driver-pause-repository";
import { DEFAULT_OCCURRENCE_TYPES } from "@/shared/delivery/default-occurrence-types";

/**
 * The twin's half of the kind → seeded type fallback (decision 14.4), which
 * DriverPauseRepository does with ensureDefaultOccurrenceTypes; the Postgres
 * half is in tests/E2E/schema-expand-contract.test.ts and the shared cases
 * in tests/E2E/driver-pause-repository-contract.test.ts.
 */
const COMPANY = "018fe1a0-0000-7000-8000-0000000000c1";
const DRIVER = "018fe1a0-0000-7000-8000-0000000000d1";

const pause = (n: number, businessId = COMPANY) => ({
  kind: "REST" as const,
  started_at: new Date(Date.UTC(2026, 9, 5, 12, n)),
  ended_at: new Date(Date.UTC(2026, 9, 5, 12, n + 1)),
  start_submission_id: `start-${n}`,
  end_submission_id: `end-${n}`,
  driverId: DRIVER,
  businessId,
});

describe("InMemoryDriverPauseRepository pause type", () => {
  it("seeds the four defaults once and stores the type of the kind's nature", async () => {
    const repo = new InMemoryDriverPauseRepository(
      [],
      [],
      [],
      [{ id: COMPANY, timezone: "America/Sao_Paulo" }],
    );

    const first = await repo.createPause(pause(0));
    const second = await repo.createPause(pause(5));

    const rest = repo.occurrenceTypes.find(
      (type) => type.system_key === "pause_rest",
    );

    expect(repo.occurrenceTypes.map((type) => type.system_key).sort()).toEqual(
      DEFAULT_OCCURRENCE_TYPES.map((type) => type.system_key).sort(),
    );
    expect(rest).toMatchObject({
      businessId: COMPANY,
      category: "PAUSE",
      pause_kind: "REST",
    });
    expect(first.status === "created" && first.pause.occurrenceTypeId).toBe(
      rest?.id,
    );
    expect(second.status === "created" && second.pause.occurrenceTypeId).toBe(
      rest?.id,
    );
  });

  it("refuses a company that does not exist, as the NOT NULL column would", async () => {
    const repo = new InMemoryDriverPauseRepository();

    await expect(
      repo.createPause(pause(0, "018fe1a0-0000-7000-8000-0000000000ff")),
    ).rejects.toThrow(/No occurrence type pause_rest/);
    expect(repo.pauses).toEqual([]);
  });
});
