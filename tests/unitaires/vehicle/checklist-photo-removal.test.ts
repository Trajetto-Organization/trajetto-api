import { describe, expect, it, vi } from "vitest";

import { UpdateVehicleChecklistUseCase } from "@/modules/vehicle-checklist/usecases/update-vehicle-checklist/update-vehicle-checklist-usecase";
import { UploadService } from "@/shared/services/upload-service";

/**
 * `photosToRemove` is a list the client sends, and every entry was deleted
 * from the bucket after the update committed — whatever it named. A user
 * allowed to edit a checklist could delete another checklist's photos, a
 * delivery's proof PDF (the legal record of the delivery), or another
 * company's files, one key at a time. Only what the checklist itself holds may
 * go now.
 */
const COMPANY_A = "0198a8d0-70c0-7000-8000-00000000000a";
const COMPANY_B = "0198a8d0-70c0-7000-8000-00000000000b";
const FOREIGN_DELIVERY = "0198a8d0-70c0-7000-8000-0000000000ff";

const OWN_PHOTOS = [
  "current_mileage",
  "fuel_level_adequate",
  "tires_condition",
].map((field) => `checklistPhotos/${COMPANY_A}/1-${field}-abcd1234.jpg`);

const OWN_BY_FIELD = `checklistPhotos/${COMPANY_A}/1-brakes-ef567890.jpg`;

function build() {
  const uploads = new UploadService();
  const deleteFile = vi.spyOn(uploads, "deleteFile").mockResolvedValue();

  const useCase = new UpdateVehicleChecklistUseCase(
    {
      findUserById: async () => ({
        id: "u1",
        role: "BUSINESS_USER",
        businessId: COMPANY_A,
        driverId: null,
      }),
    } as never,
    {
      findBusinessById: async () => ({ id: COMPANY_A, ai_analysis_limit: 0 }),
    } as never,
    {
      findVehicleById: async () => ({
        id: "v1",
        businessId: COMPANY_A,
        current_mileage: 10,
        license_plate: "AAA",
        description: "x",
      }),
    } as never,
    {} as never,
    {} as never,
    {
      getVehicleChecklistByIdAndBusiness: async () => ({
        id: "c1",
        vehicleId: "v1",
        current_mileage: 10,
        photos: OWN_PHOTOS,
        photos_by_field: { brakes: [OWN_BY_FIELD] },
      }),
      updateVehicleChecklistAndMileage: async () => ({
        id: "c1",
        vehicleId: "v1",
      }),
    } as never,
    { createActivityIfEnabled: () => undefined } as never,
    uploads,
  );

  return { useCase, deleteFile };
}

const run = (
  useCase: UpdateVehicleChecklistUseCase,
  photosToRemove: string[],
) =>
  useCase.execute({} as never, "u1", "c1", COMPANY_A, {}, photosToRemove, []);

describe("removing photos from a checklist", () => {
  it("never deletes an object the checklist does not hold", async () => {
    const { useCase, deleteFile } = build();

    await run(useCase, [
      `deliveryProofs/${FOREIGN_DELIVERY}/comprovante.pdf`,
      `https://acct.r2.cloudflarestorage.com/bucket/deliveryPhotos/${COMPANY_B}/1-canhoto-abcd1234.jpg?X-Amz-Signature=x`,
      `checklistPhotos/${COMPANY_A}/1-another-checklist-99999999.jpg`,
    ]);

    expect(deleteFile).not.toHaveBeenCalled();
  });

  it("still deletes the photos that are this checklist's own", async () => {
    const { useCase, deleteFile } = build();

    // A photo of a field with no photo requirement, so the removal is valid.
    await run(useCase, [OWN_BY_FIELD]);

    expect(deleteFile.mock.calls.map(([path]) => path)).toEqual([OWN_BY_FIELD]);
  });
});
