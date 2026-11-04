/**
 * What makes a vehicle checklist worth an alert (plan of 02/11/2026, F2;
 * decision D44): only a defect. Inspections happen daily per truck, so a
 * clean one stays silent; a failed item or a failed verdict reaches the
 * fleet's responsible (or the admins).
 *
 * The items are exactly the ones the app (trajetto-mobile
 * features/checklist/checklist-rules.ts, PHOTO_WHEN_FALSE_FIELDS and
 * PHOTO_WHEN_NOT_GOOD_FIELDS) and the API (PhotoValidationService,
 * "if_not_ok") already treat as a defect that owes a photo, plus the tyres:
 * photographed on every inspection, but a defect all the same when not good.
 * Low fuel and the documents are not the vehicle's condition and never
 * alert. Ordered by how much they matter to a truck on the road, so the
 * alert names the worst first.
 */

type DefectItem =
  | { field: string; label: string; kind: "yes_no" }
  | { field: string; label: string; kind: "graded" };

const DEFECT_ITEMS: readonly DefectItem[] = [
  { field: "brakes_working", label: "Freios", kind: "yes_no" },
  { field: "tires_condition", label: "Pneus", kind: "graded" },
  { field: "steering_wheel_condition", label: "Volante", kind: "graded" },
  { field: "brake_fluid_adequate", label: "Fluido de freio", kind: "yes_no" },
  { field: "headlights_working", label: "Faróis", kind: "yes_no" },
  { field: "taillights_working", label: "Lanternas", kind: "yes_no" },
  { field: "turn_signals_working", label: "Setas", kind: "yes_no" },
  { field: "mirrors_condition", label: "Retrovisores", kind: "graded" },
  { field: "windshield_condition", label: "Para-brisa", kind: "graded" },
  { field: "seatbelts_working", label: "Cintos de segurança", kind: "yes_no" },
  { field: "clutch_working", label: "Embreagem", kind: "yes_no" },
  { field: "oil_level_adequate", label: "Nível de óleo", kind: "yes_no" },
  {
    field: "radiator_water_adequate",
    label: "Água do radiador",
    kind: "yes_no",
  },
  { field: "battery_condition", label: "Bateria", kind: "graded" },
  { field: "dashboard_working", label: "Painel", kind: "yes_no" },
  { field: "bumpers_condition", label: "Para-choques", kind: "graded" },
  { field: "spare_tire_condition", label: "Estepe", kind: "graded" },
];

const VERDICT_LABELS: Record<string, string> = {
  rejected: "Reprovado",
  approved_with_restrictions: "Aprovado com restrições",
};

interface ChecklistDefects {
  /** The failed items, by label, worst first. */
  items: string[];
  /** The failed or restricted verdict, by label; null when approved. */
  verdict: string | null;
}

function checklistDefects(record: object): ChecklistDefects {
  const checklist = record as Record<string, unknown>;

  const items = DEFECT_ITEMS.filter(({ field, kind }) => {
    const answer = checklist[field];

    // An unanswered item owes an answer, not an alert.
    return kind === "yes_no"
      ? answer === false
      : answer === "bad" || answer === "needs_attention";
  }).map(({ label }) => label);

  const overall = checklist.overall_condition;

  return {
    items,
    verdict:
      typeof overall === "string" ? (VERDICT_LABELS[overall] ?? null) : null,
  };
}

function hasDefects(defects: ChecklistDefects): boolean {
  return defects.items.length > 0 || defects.verdict !== null;
}

export { DEFECT_ITEMS, checklistDefects, hasDefects };
export type { ChecklistDefects };
