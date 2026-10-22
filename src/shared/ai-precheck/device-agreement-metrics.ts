import type { DeviceAgreement } from "./device-precheck";

/**
 * ai_device_agreement_total{kind,result} (ADR 0010 §4, design §P5.2): how
 * often the phone's offline pre-check agreed with the server's reading of the
 * same photo, counted when the server's verdict is written.
 *
 * Per replica and since it started, like the legacy-contract counters: the
 * stored columns (delivery_proof_audit.device_agreement,
 * fuel.odometer_device_agreement, vehicle_checklist.mileage_device_agreement)
 * are the durable source; this is the quick look in /health/metrics.
 */
type DeviceAgreementKind = "proof" | "fuel_odometer" | "checklist_mileage";

type DeviceAgreementCounts = Record<DeviceAgreement, number>;

function zero(): DeviceAgreementCounts {
  return { AGREE: 0, DISAGREE: 0, NOT_APPLICABLE: 0 };
}

const totals: Record<DeviceAgreementKind, DeviceAgreementCounts> = {
  proof: zero(),
  fuel_odometer: zero(),
  checklist_mileage: zero(),
};

/** Counts one written verdict; null (nothing to compare) is not counted. */
function countDeviceAgreement(
  kind: DeviceAgreementKind,
  result: DeviceAgreement | null,
): void {
  if (result === null) return;

  totals[kind][result] += 1;
}

/** A snapshot, for /health/metrics. */
function deviceAgreementTotals(): Record<
  DeviceAgreementKind,
  DeviceAgreementCounts
> {
  return {
    proof: { ...totals.proof },
    fuel_odometer: { ...totals.fuel_odometer },
    checklist_mileage: { ...totals.checklist_mileage },
  };
}

export { countDeviceAgreement, deviceAgreementTotals };
export type { DeviceAgreementCounts, DeviceAgreementKind };
