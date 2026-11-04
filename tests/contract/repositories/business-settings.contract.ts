import { describe, expect, it } from "vitest";

import type { IBusinessSettingsRepository } from "@/modules/business/repositories/IBusiness-settings-repository";

import { fixedId, type Kind } from "../support";

/**
 * The business settings repository's contract (plan of 02/11/2026, M1):
 * what the settings screen, the session and the driver's payload rely on —
 * no row until the first save, the column defaults on it, absent fields
 * kept on the next ones, and one company's row never read for another.
 */

const ALFA = fixedId("05e7", 1);
const BETA = fixedId("05e7", 2);
const GAMMA = fixedId("05e7", 3);

interface BusinessSettingsHarness {
  kind: Kind;
  repo: IBusinessSettingsRepository;
  /** A user of the company that can be named as the one who saved. */
  editorId: string;
  otherEditorId: string;
}

function businessSettingsRepositoryContract(
  harness: () => BusinessSettingsHarness,
): void {
  describe("before the first save", () => {
    it("has no row, so the company reads the defaults", async () => {
      expect(await harness().repo.findByBusinessId(GAMMA)).toBeNull();
    });
  });

  describe("save", () => {
    it("creates the row with the column defaults for the fields not given", async () => {
      const { repo, editorId } = harness();

      const row = await repo.save({
        businessId: ALFA,
        updatedById: editorId,
        arrival_geofence_mode: "ALERT",
      });

      expect(row).toMatchObject({
        businessId: ALFA,
        checklist_requirement: "NONE",
        arrival_geofence_mode: "ALERT",
        arrival_geofence_radius_m: 500,
        updatedById: editorId,
      });
      expect(row.id).toEqual(expect.any(String));
      expect(row.created_at).toBeInstanceOf(Date);
      expect(row.updated_at).toBeInstanceOf(Date);
    });

    it("updates the same row, keeping what was not given, and says who saved", async () => {
      const { repo, otherEditorId } = harness();
      const before = await repo.findByBusinessId(ALFA);

      const row = await repo.save({
        businessId: ALFA,
        updatedById: otherEditorId,
        checklist_requirement: "ROUTE_START_AND_END",
        arrival_geofence_radius_m: 1200,
        arrival_geofence_mode: undefined,
      });

      expect(row).toMatchObject({
        id: before?.id,
        checklist_requirement: "ROUTE_START_AND_END",
        arrival_geofence_mode: "ALERT",
        arrival_geofence_radius_m: 1200,
        updatedById: otherEditorId,
      });
      expect(await repo.findByBusinessId(ALFA)).toMatchObject({
        checklist_requirement: "ROUTE_START_AND_END",
        arrival_geofence_mode: "ALERT",
        arrival_geofence_radius_m: 1200,
      });
    });

    it("keeps each company's row to itself", async () => {
      const { repo, editorId } = harness();

      await repo.save({
        businessId: BETA,
        updatedById: editorId,
        arrival_geofence_mode: "BLOCK",
      });

      expect(await repo.findByBusinessId(BETA)).toMatchObject({
        businessId: BETA,
        arrival_geofence_mode: "BLOCK",
        checklist_requirement: "NONE",
      });
      expect(await repo.findByBusinessId(ALFA)).toMatchObject({
        arrival_geofence_mode: "ALERT",
      });
      expect(await repo.findByBusinessId(GAMMA)).toBeNull();
    });
  });
}

export { ALFA, BETA, GAMMA, businessSettingsRepositoryContract };
export type { BusinessSettingsHarness };
