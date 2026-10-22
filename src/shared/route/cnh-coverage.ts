/**
 * Whether a driver's CNH category covers the one a vehicle type requires
 * (decision 8.5: the assignment WARNS about an incompatible category, it
 * never refuses — the office may know something the record does not).
 *
 * The four-wheel categories form a ladder (CTB art. 143): C also drives B,
 * D drives B and C, E drives B, C and D. A (two or three wheels) stands
 * apart, and the combined categories (AB, AC, AD, AE) are A plus the rung
 * after the letter.
 */

type CnhCategory = "A" | "B" | "C" | "D" | "E" | "AB" | "AC" | "AD" | "AE";

const CNH_CATEGORIES: readonly CnhCategory[] = [
  "A",
  "B",
  "C",
  "D",
  "E",
  "AB",
  "AC",
  "AD",
  "AE",
];

/** The four-wheel rung of each letter; 0 = none. */
const RUNG: Record<string, number> = { B: 1, C: 2, D: 3, E: 4 };

function parts(category: CnhCategory): { motorcycle: boolean; rung: number } {
  const motorcycle = category.startsWith("A");
  const letter =
    category.length === 2 ? category[1] : motorcycle ? "" : category;

  return { motorcycle, rung: RUNG[letter] ?? 0 };
}

function isCnhCategory(value: unknown): value is CnhCategory {
  return (
    typeof value === "string" &&
    (CNH_CATEGORIES as readonly string[]).includes(value)
  );
}

/**
 * True when `held` lets its owner drive a vehicle that requires `required`.
 * A requirement of null means the type asks for nothing in particular.
 */
function cnhCovers(held: CnhCategory, required: CnhCategory | null): boolean {
  if (!required) return true;

  const have = parts(held);
  const need = parts(required);

  return (!need.motorcycle || have.motorcycle) && have.rung >= need.rung;
}

export { CNH_CATEGORIES, cnhCovers, isCnhCategory };
export type { CnhCategory };
