/**
 * The name of a shipper the NF-e import creates for an issuer whose name is
 * already another shipper's, with another CNPJ (decision D-36, 14/11/2026).
 *
 * A matriz and its filial share the corporate name and have different
 * CNPJs. The shipper's name is unique per company and the import never
 * merges two CNPJs, so the filial's first note used to be refused with
 * NFE_ISSUER_NAME_TAKEN. The name stays unique; the filial's shipper takes
 * it with the CNPJ's branch number and check digits — "Magazine X
 * (0002-90)" —, the part that tells the establishments of one company
 * apart, and the person can rename it later.
 *
 * Pure: the import checks the result against the company's shipper names.
 */

/** The longest shipper name the panel accepts (create-shipper-schema). */
const SHIPPER_NAME_MAX = 150;

/**
 * The issuer's name with the CNPJ's branch suffix, within the panel's
 * length; null without a valid 14-digit CNPJ, which has no suffix to tell
 * the two apart.
 */
function issuerShipperName(name: string, cnpj: string | null): string | null {
  const digits = cnpj?.replace(/\D/g, "") ?? "";

  if (digits.length !== 14) return null;

  const suffix = ` (${digits.slice(8, 12)}-${digits.slice(12)})`;
  const base = name
    .trim()
    .slice(0, SHIPPER_NAME_MAX - suffix.length)
    .trimEnd();

  if (base === "") return null;

  return `${base}${suffix}`;
}

export { issuerShipperName, SHIPPER_NAME_MAX };
