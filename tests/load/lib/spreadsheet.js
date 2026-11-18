/**
 * The spreadsheet the import scenes upload (plano-escala LOAD-04): a CSV in
 * the template's columns (shared/delivery/spreadsheet-template.ts), built
 * in the scene, never a file in the repository. No k6 import: the scenes
 * encode it (k6/encoding), and compose-load-harness reads it with the
 * importer's own parser.
 *
 * `rows` data rows plus the header: the importer counts the header among
 * the 20 000 rows it accepts (spreadsheet-reader.ts), so the scenes default
 * to 19 999 rows, a file of 20 000 lines. Each row is a delivery of its own:
 * the order code and the street carry the run's `marker`, so a run never
 * meets the previous one's rows as duplicates, and every address is a
 * lookup of its own for the geocoder (no two rows share a point to reuse).
 * With `coordinates`, each row brings its point (the import alone is
 * measured); without, the geocoder looks every one of them up.
 */
const HEADER = [
  "Destinatário",
  "CEP",
  "Cidade",
  "UF",
  "Logradouro",
  "Número",
  "Bairro",
  "Latitude",
  "Longitude",
  "Pedido",
];

/** The importer's ceiling, the header included (spreadsheet-reader.ts). */
const MAX_LINES = 20_000;

function spreadsheetRows(rows, marker, { coordinates }) {
  const lines = [HEADER.join(";")];

  for (let n = 1; n <= rows; n += 1) {
    const latitude = coordinates
      ? (-23.5505 + ((n % 400) - 200) / 10_000).toFixed(6)
      : "";
    const longitude = coordinates
      ? (-46.6333 + ((n % 397) - 198) / 10_000).toFixed(6)
      : "";

    lines.push(
      [
        `Cliente ${n}`,
        "01001000",
        "Sao Paulo",
        "SP",
        `Rua Carga ${marker}`,
        String(n),
        "Centro",
        latitude,
        longitude,
        `carga-${marker}-${n}`,
      ].join(";"),
    );
  }

  return { filename: `carga-${marker}.csv`, text: lines.join("\n") };
}

export { HEADER, MAX_LINES, spreadsheetRows };
