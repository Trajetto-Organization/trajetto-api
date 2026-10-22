/**
 * Loads the product's AI modules (src/shared/ai) straight from their
 * TypeScript source, so the benchmark measures the prompts and verdict rules
 * that ship today instead of a hand-kept copy that can drift from them.
 *
 * Each file is transpiled on its own: types are erased, so the type-only
 * imports of @prisma/client and ai-types disappear. The result runs with a
 * `require` that knows a short allowlist: sibling files, a few node builtins
 * and `zod` (the answer schemas are the product's own). Any other runtime
 * import fails the load loudly rather than pulling Prisma, tsyringe or the
 * API's environment into a standalone script.
 *
 * Since ADR 0010 the prompts live in ai-prompts.ts (no imports at all), the
 * reader's defaults in ai-provider-defaults.ts and the OCR rules in
 * local/ocr-readings.ts (no imports either), so nothing here needs a stub.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = path.dirname(fileURLToPath(import.meta.url));
const AI_SOURCE_DIR = path.resolve(here, "../../src/shared/ai");
const nodeRequire = createRequire(import.meta.url);

const ALLOWED_BUILTINS = new Set(["node:crypto", "node:fs", "node:path"]);

/** Pure libraries the product's AI rules use at runtime. */
const ALLOWED_PACKAGES = new Set(["zod"]);

const cache = new Map();

function loadTypeScriptModule(file) {
  const resolved = path.resolve(file);
  if (cache.has(resolved)) return cache.get(resolved);

  const ts = nodeRequire("typescript");
  const source = fs.readFileSync(resolved, "utf8");
  const { outputText } = ts.transpileModule(source, {
    fileName: resolved,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  });

  const module = { exports: {} };
  cache.set(resolved, module.exports);

  const localRequire = (specifier) => {
    if (ALLOWED_BUILTINS.has(specifier) || ALLOWED_PACKAGES.has(specifier)) {
      return nodeRequire(specifier);
    }

    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const sibling = path.resolve(path.dirname(resolved), `${specifier}.ts`);
      return loadTypeScriptModule(sibling);
    }

    throw new Error(
      `${path.basename(resolved)} now imports "${specifier}" at runtime; the benchmark ` +
        "does not load it (no Prisma, tsyringe or API env). Keep the prompts and rules " +
        "free of it, or allow it in scripts/ai-benchmark/product-source.mjs if it is pure.",
    );
  };

  const run = vm.compileFunction(
    outputText,
    ["exports", "require", "module", "__filename", "__dirname"],
    { filename: resolved },
  );
  run(module.exports, localRequire, module, resolved, path.dirname(resolved));

  cache.set(resolved, module.exports);
  return module.exports;
}

function requireExport(moduleExports, name, file) {
  if (moduleExports[name] === undefined) {
    throw new Error(
      `${file} no longer exports ${name}; update scripts/ai-benchmark/product-source.mjs`,
    );
  }

  return moduleExports[name];
}

/**
 * The verdict rules (ai-rules.ts), the answer schemas (ai-answers.ts) and the
 * receipt assessment (proof-criteria.ts), as the product runs them.
 */
function loadProductRules(sourceDir = AI_SOURCE_DIR) {
  const rules = loadTypeScriptModule(path.join(sourceDir, "ai-rules.ts"));
  const answers = loadTypeScriptModule(path.join(sourceDir, "ai-answers.ts"));
  const prompts = loadTypeScriptModule(path.join(sourceDir, "ai-prompts.ts"));
  const criteria = loadTypeScriptModule(
    path.join(sourceDir, "proof-criteria.ts"),
  );
  const types = loadTypeScriptModule(path.join(sourceDir, "ai-types.ts"));

  return {
    evaluateOdometerReading: requireExport(
      rules,
      "evaluateOdometerReading",
      "ai-rules.ts",
    ),
    evaluateChecklistField: requireExport(
      rules,
      "evaluateChecklistField",
      "ai-rules.ts",
    ),
    readProofExtraction: requireExport(
      rules,
      "readProofExtraction",
      "ai-rules.ts",
    ),
    parseModelAnswer: requireExport(
      answers,
      "parseModelAnswer",
      "ai-answers.ts",
    ),
    checklistFieldSpec: requireExport(
      prompts,
      "checklistFieldSpec",
      "ai-prompts.ts",
    ),
    assessProof: requireExport(criteria, "assessProof", "proof-criteria.ts"),
    // The receipt input the product builds (decision 6.9): without it the
    // expected NF-e number is not compared.
    PROOF_INPUT_VERSION: requireExport(
      types,
      "PROOF_INPUT_VERSION",
      "ai-types.ts",
    ),
  };
}

/**
 * The prompts the product sends and the JSON schema of each answer, built by
 * the product's own functions (builder selection included), plus the call
 * budget of the product's reader (the local OCR service, ADR 0010).
 */
function loadProductProvider(sourceDir = AI_SOURCE_DIR) {
  const promptsFile = "ai-prompts.ts";
  const prompts = loadTypeScriptModule(path.join(sourceDir, promptsFile));
  const defaults = loadTypeScriptModule(
    path.join(sourceDir, "ai-provider-defaults.ts"),
  );

  const odometerPrompt = requireExport(prompts, "odometerPrompt", promptsFile);
  const checklistFieldPrompt = requireExport(
    prompts,
    "checklistFieldPrompt",
    promptsFile,
  );
  const checklistFieldSpec = requireExport(
    prompts,
    "checklistFieldSpec",
    promptsFile,
  );
  const proofExtractionPrompt = requireExport(
    prompts,
    "proofExtractionPrompt",
    promptsFile,
  );
  const schemas = requireExport(prompts, "ANSWER_JSON_SCHEMAS", promptsFile);

  return {
    timeoutMs: requireExport(
      defaults,
      "LOCAL_AI_DEFAULT_TIMEOUT_MS",
      "ai-provider-defaults.ts",
    ),
    maxRetries: requireExport(
      defaults,
      "LOCAL_AI_MAX_RETRIES",
      "ai-provider-defaults.ts",
    ),

    // Blind: the reported mileage and the expected document never reach the
    // model (ADR 0010); the code compares.
    odometerPrompt: () => odometerPrompt(),
    checklistPrompt: (fieldName, fieldValue) =>
      checklistFieldPrompt(checklistFieldSpec(fieldName, fieldValue)),
    checklistKind: (fieldName, fieldValue) =>
      checklistFieldSpec(fieldName, fieldValue).kind,
    proofPrompt: () => proofExtractionPrompt(),
    schemas,
  };
}

/**
 * The product's OCR rules (local/ocr-readings.ts): lines -> answer, exactly
 * what LocalOcrReader runs on the service's output (ADR 0010 §3, item 2).
 */
function loadProductOcrRules(sourceDir = AI_SOURCE_DIR) {
  const file = "local/ocr-readings.ts";
  const rules = loadTypeScriptModule(path.join(sourceDir, file));

  return {
    proofFromLines: requireExport(rules, "proofFromLines", file),
    odometerFromLines: requireExport(rules, "odometerFromLines", file),
    OCR_RULES_VERSION: requireExport(rules, "OCR_RULES_VERSION", file),
  };
}

export {
  AI_SOURCE_DIR,
  loadProductOcrRules,
  loadProductProvider,
  loadProductRules,
};
