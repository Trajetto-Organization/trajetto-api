import database from "@/../infra/database";
import { Prisma } from "@prisma/client";

import { ChecklistFieldOutcome } from "./ai-rules";
import { OdometerUnitResult } from "./ai-types";

/**
 * Writers for the AI verdict fields on the business records (Fuel and
 * VehicleChecklist). Both the request service (skip marking) and the
 * pipeline (progress + results) go through here so the field semantics live
 * in one place.
 */

async function markFuelAnalyzing(recordId: string): Promise<void> {
  await database.fuel.update({
    where: { id: recordId },
    data: { odometer_ai_status: "analyzing" },
  });
}

async function markFuelSkipped(recordId: string): Promise<void> {
  await database.fuel.update({
    where: { id: recordId },
    data: {
      odometer_ai_status: "skipped",
      odometer_ai_analyzed_at: new Date(),
    },
  });
}

async function markFuelError(recordId: string): Promise<void> {
  await database.fuel.update({
    where: { id: recordId },
    data: {
      odometer_ai_status: "error",
      odometer_ai_analyzed_at: new Date(),
    },
  });
}

async function writeFuelResult(
  recordId: string,
  result: OdometerUnitResult,
): Promise<void> {
  await database.fuel.update({
    where: { id: recordId },
    data: {
      odometer_ai_reading: result.readMileage,
      odometer_ai_status: result.status,
      odometer_ai_details: result.rawResponse as Prisma.InputJsonValue,
      odometer_ai_analyzed_at: new Date(),
      odometer_verified: result.status === "verified",
    },
  });
}

async function markChecklistAnalyzing(recordId: string): Promise<void> {
  await database.vehicleChecklist.update({
    where: { id: recordId },
    data: { ai_verification_status: "analyzing" },
  });
}

async function markChecklistSkipped(recordId: string): Promise<void> {
  await database.vehicleChecklist.update({
    where: { id: recordId },
    data: {
      ai_verification_status: "skipped",
      ai_verified_at: new Date(),
    },
  });
}

async function readChecklistExistingDetails(
  recordId: string,
): Promise<Record<string, ChecklistFieldOutcome>> {
  const checklist = await database.vehicleChecklist.findUnique({
    where: { id: recordId },
    select: { ai_verification_details: true },
  });

  if (!checklist?.ai_verification_details) return {};

  // Older rows stored the JSON as a string.
  return typeof checklist.ai_verification_details === "string"
    ? JSON.parse(checklist.ai_verification_details)
    : (checklist.ai_verification_details as unknown as Record<
        string,
        ChecklistFieldOutcome
      >);
}

async function writeChecklistResults(
  recordId: string,
  mergedDetails: Record<string, ChecklistFieldOutcome>,
  overallStatus: string,
): Promise<void> {
  await database.vehicleChecklist.update({
    where: { id: recordId },
    data: {
      ai_verification_status: overallStatus,
      ai_verification_details: mergedDetails as unknown as Prisma.InputJsonValue,
      ai_verified_at: new Date(),
    },
  });
}

export {
  markChecklistAnalyzing,
  markChecklistSkipped,
  markFuelAnalyzing,
  markFuelError,
  markFuelSkipped,
  readChecklistExistingDetails,
  writeChecklistResults,
  writeFuelResult,
};
