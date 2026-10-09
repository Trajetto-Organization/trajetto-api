/**
 * What the benchmark asks each model.
 *
 * The prompts are not copied here: they are the product's own, built by
 * src/shared/ai/ai-prompts.ts (loaded from source by product-source.mjs). A
 * prompt the product changes, extends or reorders is the prompt the next run
 * sends, and so are the JSON schemas Ollama's constrained decoding uses —
 * the product keeps them next to the prompts. `schemaDrift` still checks each
 * schema against the keys and choices the prompt asks for, because a schema
 * that lags the prompt would silently forbid the model from answering a new
 * question.
 *
 * Since ADR 0010 the product's prompts ARE the variants this benchmark used
 * to measure on the side: the odometer and the checklist are read blind (no
 * informed value in the prompt) and the receipt is transcribed (decision
 * 6.9). `blind` and `extract` are kept as names so the earlier runs' tables
 * stay comparable; they send the product's prompts, like `prod`.
 */
import { loadProductProvider } from "./product-source.mjs";

let productProvider = null;

/** The product's prompts and schemas, loaded once per process. */
function product() {
  productProvider ??= loadProductProvider();
  return productProvider;
}

/** The product's odometer prompt, which carries no informed mileage. */
async function odometerBlindPrompt() {
  return product().odometerPrompt();
}

/** The product's receipt prompt: transcription, compared in code. */
function proofExtractionPrompt() {
  return product().proofPrompt();
}

/** Which tasks each prompt variant applies to. */
const VARIANT_TASKS = {
  prod: ["odometer", "checklist", "proof"],
  extract: ["proof"],
  blind: ["odometer"],
};

/** The product's answer schemas, by the kind of reading. */
function schemas() {
  return product().schemas;
}

/**
 * Prompt + schema for one dataset item and prompt variant. Every variant
 * sends the product's prompt; see the header.
 */
async function buildRequest(item) {
  if (item.task === "odometer") {
    return { prompt: product().odometerPrompt(), schema: schemas().odometer, kind: "odometer" };
  }

  if (item.task === "checklist") {
    const { fieldName, fieldValue } = item.input;
    const kind = product().checklistKind(fieldName, fieldValue);

    return {
      prompt: product().checklistPrompt(fieldName, fieldValue),
      schema: schemas()[kind],
      kind,
    };
  }

  return { prompt: product().proofPrompt(), schema: schemas().proof, kind: "proof" };
}

/**
 * The keys (and, where the prompt lists them, the allowed strings) of the
 * answer template at the end of a prompt: the last `{ "key": ... }` block.
 */
function promptAnswerShape(prompt) {
  const starts = [...prompt.matchAll(/\{\s*"/g)];
  if (starts.length === 0) return null;

  const start = starts[starts.length - 1].index;
  const end = prompt.indexOf("}", start);
  const template = prompt.slice(start, end === -1 ? undefined : end + 1);

  const shape = new Map();
  for (const [, key, value] of template.matchAll(/"([A-Za-z_]+)"\s*:\s*([^,\n}]*)/g)) {
    const choices = /^"[^"]*"(\s*\|\s*"[^"]*")+\s*$/.test(value.trim())
      ? [...value.matchAll(/"([^"]*)"/g)].map((match) => match[1])
      : null;
    shape.set(key, choices);
  }

  return shape;
}

/**
 * Differences between what a prompt asks for and the schema Ollama is held
 * to, in both directions. Empty means they agree.
 */
function schemaDrift(prompt, schema, label = "prompt") {
  const shape = promptAnswerShape(prompt);
  if (!shape) return [`${label}: no JSON answer template found in the prompt`];

  const properties = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const drift = [];

  for (const [key, choices] of shape) {
    if (!properties[key]) {
      drift.push(`${label}: the prompt asks for "${key}", the Ollama schema does not have it`);
      continue;
    }
    if (!required.has(key)) drift.push(`${label}: "${key}" is not required in the Ollama schema`);

    const allowed = properties[key].enum ?? null;
    const same =
      (choices === null && allowed === null) ||
      (choices !== null &&
        allowed !== null &&
        [...choices].sort().join("|") === [...allowed].sort().join("|"));

    if (!same) {
      drift.push(
        `${label}: "${key}" allows ${JSON.stringify(choices)} in the prompt and ${JSON.stringify(allowed)} in the Ollama schema`,
      );
    }
  }

  for (const key of Object.keys(properties)) {
    if (!shape.has(key)) {
      drift.push(`${label}: the Ollama schema has "${key}", the prompt no longer asks for it`);
    }
  }

  return drift;
}

/** The product reader's call budget (timeout and retries), reused by the runner. */
function productClientSettings() {
  return { timeout: product().timeoutMs, maxRetries: product().maxRetries };
}

export {
  VARIANT_TASKS,
  buildRequest,
  odometerBlindPrompt,
  productClientSettings,
  proofExtractionPrompt,
  schemaDrift,
  schemas as productSchemas,
};
