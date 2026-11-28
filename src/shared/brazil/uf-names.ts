import { foldText } from "@/shared/utils/fold-text";

/**
 * The 27 federative units and the names OpenStreetMap gives their states.
 *
 * The address search (shared/services/address-search/) reads both ways:
 * the delivery's UF becomes the state's name in the text the provider
 * searches ("Rua Epitácio Pessoa, Petrópolis, Rio de Janeiro"), and a
 * result's `address.state` becomes the UF its suggestion shows.
 */
const UF_NAMES = {
  AC: "Acre",
  AL: "Alagoas",
  AP: "Amapá",
  AM: "Amazonas",
  BA: "Bahia",
  CE: "Ceará",
  DF: "Distrito Federal",
  ES: "Espírito Santo",
  GO: "Goiás",
  MA: "Maranhão",
  MT: "Mato Grosso",
  MS: "Mato Grosso do Sul",
  MG: "Minas Gerais",
  PA: "Pará",
  PB: "Paraíba",
  PR: "Paraná",
  PE: "Pernambuco",
  PI: "Piauí",
  RJ: "Rio de Janeiro",
  RN: "Rio Grande do Norte",
  RS: "Rio Grande do Sul",
  RO: "Rondônia",
  RR: "Roraima",
  SC: "Santa Catarina",
  SP: "São Paulo",
  SE: "Sergipe",
  TO: "Tocantins",
} as const;

type Uf = keyof typeof UF_NAMES;

const UFS = Object.keys(UF_NAMES) as Uf[];

function isUf(value: unknown): value is Uf {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(UF_NAMES, value)
  );
}

// "São Paulo" and "sao paulo" are one state: the fold of every place name.
const UF_BY_FOLDED_NAME = new Map<string, Uf>(
  UFS.map((uf) => [foldText(UF_NAMES[uf]), uf]),
);

/**
 * The UF a provider names: "RJ", "BR-RJ" (ISO 3166-2, Nominatim's
 * `ISO3166-2-lvl4`) or the state's name in any case and accent ("Estado do
 * Rio de Janeiro" included). Null when it names none of the 27.
 */
function ufOf(value: string | null | undefined): Uf | null {
  const raw = value?.trim() ?? "";

  if (!raw) return null;

  const code = raw.toUpperCase().replace(/^BR-/, "");

  if (isUf(code)) return code;

  const folded = foldText(raw).replace(/^estado d[oea] /, "");

  return UF_BY_FOLDED_NAME.get(folded) ?? null;
}

export { UF_NAMES, UFS, isUf, ufOf };
export type { Uf };
