import type { UpdateBusinessProps } from "@/modules/business/dtos/business-dto";

import type { Branch, UpdateBranchProps } from "./dtos/branch-dto";

/**
 * The head office ("matriz"): the branch created with the company, carrying
 * the company's own CNPJ (CreateBusinessUseCase). It is a copy of the
 * company's record, and the copy runs one way: every save in Empresas
 * rewrites it (UpdateBusinessUseCase), so the company is where its data
 * lives.
 *
 * Audit of 11/2026: Filiais edited it freely and nothing synced back, so an
 * edit there was silently reverted by the next company save, and a CNPJ
 * changed there broke the link for good (the company finds its head office
 * by CNPJ). Filiais now shows it read-only (`is_head_office` on the list
 * rows) and the update refuses to change it.
 */

/** A field both the company form and the branch form carry. */
type MirroredField = Exclude<keyof UpdateBusinessProps, "id" | "timezone"> &
  keyof UpdateBranchProps;

/**
 * The fields the company writes onto its head office: every field of the
 * company form but the zone, which the branch table does not have. Typed
 * against the company's update, so a field the company stops mirroring is a
 * compile error here; branch-head-office.test.ts holds the list against both
 * request bodies, so a new mirrored field cannot be left editable.
 */
const HEAD_OFFICE_MIRRORED_FIELDS = [
  "corporate_reason",
  "fantasy_name",
  "cep",
  "city",
  "uf",
  "street",
  "address_number",
  "cnpj",
  "complement",
  "cnae",
  "erp_code",
  "responsible_name",
  "telephone",
  "email",
] as const satisfies readonly MirroredField[];

/** The head office of `business`: its branch with the company's CNPJ. */
function isHeadOffice(
  branch: Pick<Branch, "cnpj" | "businessId">,
  business: { id?: string; cnpj: string },
): boolean {
  return branch.businessId === business.id && branch.cnpj === business.cnpj;
}

/** An empty text and a null are the same "no value" in these columns. */
function sameValue(current: unknown, next: unknown): boolean {
  const normalize = (value: unknown) =>
    value === undefined || value === "" ? null : value;

  return normalize(current) === normalize(next);
}

/**
 * The mirrored fields an edit would change. A form sent back with the
 * values it already has changes none, so it is no refusal.
 */
function headOfficeChanges(
  branch: Partial<Record<keyof UpdateBranchProps, unknown>>,
  edit: UpdateBranchProps,
): string[] {
  return HEAD_OFFICE_MIRRORED_FIELDS.filter(
    (field) =>
      edit[field] !== undefined && !sameValue(branch[field], edit[field]),
  );
}

export { HEAD_OFFICE_MIRRORED_FIELDS, headOfficeChanges, isHeadOffice };
