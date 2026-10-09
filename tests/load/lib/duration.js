/**
 * A k6 duration ("30m", "1h30m", "45s", "500ms") in milliseconds.
 *
 * Pure and k6-free, so the scenarios can derive their own lengths from the
 * durations they already declare instead of asking for them twice.
 */
const UNITS = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };

function parseDuration(text) {
  const value = String(text).trim();
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];

  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== value) {
    throw new Error(`Duração inválida: '${text}' (use 30m, 1h30m, 45s ou 500ms).`);
  }

  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * UNITS[unit], 0);
}

/** The whole length of a ramping executor, from its stages. */
function stagesDuration(stages) {
  return stages.reduce((total, stage) => total + parseDuration(stage.duration), 0);
}

export { parseDuration, stagesDuration };
