import { describe, expect, it } from "vitest";
import { RecordOrigin } from "@prisma/client";

import { InMemoryFuelRepository } from "@/modules/fuel/repositories/in-memory/in-memory-fuel-repository";

import { InMemoryVehicleChecklistRepository } from "@/modules/vehicle-checklist/repositories/in-memory/in-memory-vehicle-checklist-repository";
import { CreateVehicleChecklistProps } from "@/modules/vehicle-checklist/dtos/vehicle-checklist-dto";

const submissionId = "018f47a6-7b3c-7c4d-8e5f-0123456789ab";

describe("mobile submission idempotency", () => {
  it("returns the original fuel record and never trusts a client total", async () => {
    const repository = new InMemoryFuelRepository();
    const submission = {
      client_submission_id: submissionId,
      current_mileage: 10_001,
      liters_amount: 10,
      price_per_liter: 5.5,
      total_amount: 999_999,
      odometer_photo: "odometerPhotos/photo.webp",
      refueling_date: new Date(),
      businessId: "018f47a6-0000-7000-8000-000000000001",
      branchId: "018f47a6-0000-7000-8000-000000000002",
      vehicleId: "018f47a6-0000-7000-8000-000000000003",
      driverId: "018f47a6-0000-7000-8000-000000000004",
      fuelTypeId: "018f47a6-0000-7000-8000-000000000005",
      created_from: RecordOrigin.MOBILE_APP,
    };

    const first = await repository.createFuelWithMileage(submission);
    const retry = await repository.createFuelWithMileage(submission);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);

    expect(retry.fuel.id).toBe(first.fuel.id);
    expect(repository.fuels).toHaveLength(1);

    expect(first.fuel.total_amount.toNumber()).toBe(55);
  });

  it("returns the original checklist for the same company and key", async () => {
    const repository = new InMemoryVehicleChecklistRepository();
    const submission: CreateVehicleChecklistProps = {
      client_submission_id: submissionId,
      current_mileage: 10_002,
      tires_condition: "good",
      headlights_working: true,
      taillights_working: true,
      turn_signals_working: true,
      bumpers_condition: "good",
      windshield_condition: "good",
      mirrors_condition: "good",
      seatbelts_working: true,
      dashboard_working: true,
      steering_wheel_condition: "good",
      brakes_working: true,
      clutch_working: true,
      fuel_level_adequate: true,
      oil_level_adequate: true,
      radiator_water_adequate: true,
      brake_fluid_adequate: true,
      battery_condition: "good",
      driver_license_valid: true,
      vehicle_documents_valid: true,
      insurance_valid: true,
      fire_extinguisher_valid: true,
      warning_triangle_present: true,
      jack_present: true,
      spare_tire_condition: "good",
      photos: ["checklistPhotos/photo.webp"],
      overall_condition: "approved",
      businessId: "018f47a6-0000-7000-8000-000000000001",
      branchId: "018f47a6-0000-7000-8000-000000000002",
      vehicleId: "018f47a6-0000-7000-8000-000000000003",
      driverId: "018f47a6-0000-7000-8000-000000000004",
    };

    const first =
      await repository.createVehicleChecklistWithMileage(submission);
    const retry =
      await repository.createVehicleChecklistWithMileage(submission);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);

    expect(retry.checklist.id).toBe(first.checklist.id);
    expect(repository.checklists).toHaveLength(1);
  });
});
