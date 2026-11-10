/**
 * "Rua Epitácio Pessoa" → "rua epitacio pessoa": no accents, no case, no
 * punctuation, single spaces — how a street, a district, a city or a state
 * typed in a form is compared with the name OpenStreetMap gives it. One rule
 * for every comparison of place names: the geocoder's, the address search's
 * ranking and the UF a provider names (shared/brazil/uf-names.ts).
 */
function foldText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export { foldText };
