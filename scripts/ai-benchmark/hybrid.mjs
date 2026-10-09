/**
 * The hybrid pipeline, assembled from two runs already measured on the same
 * dataset: a classical OCR run (--provider ocr) for the text and the digits,
 * and a vision-model run (--provider ollama) for the yes/no and category
 * questions. No new inference: each answer is merged field by field, and the
 * latency of an item is the sum of both calls (they would run one after the
 * other on the same box).
 *
 *   npx tsx scripts/ai-benchmark/hybrid.mjs --ocr <ocr run> --vlm <vlm run> \
 *     --out <dir> [--date-fallback vlm]
 *
 * Fields taken from the OCR: invoice number, receiving date, odometer digits
 * (and "is a receipt" / "legible" when the OCR found the stub's printed
 * labels). From the vision model: signature, fraud signs, "is not an
 * odometer", every non-numeric checklist item, and whether it is a receipt
 * when the OCR found no label. --date-fallback vlm uses the model's date when
 * the OCR found none (the handwriting fallback).
 *
 * The merged answer goes through evaluate.mjs like any other run.
 */
import fs from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = { ocr: null, vlm: null, out: null, dateFallback: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--ocr") args.ocr = path.resolve(argv[++i]);
    else if (flag === "--vlm") args.vlm = path.resolve(argv[++i]);
    else if (flag === "--out") args.out = path.resolve(argv[++i]);
    else if (flag === "--date-fallback") args.dateFallback = argv[++i];
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!args.ocr || !args.vlm || !args.out) throw new Error("--ocr, --vlm and --out are required");
  return args;
}

function latest(file) {
  const map = new Map();
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean)) {
    const record = JSON.parse(line);
    if (record.variant === "prod") map.set(record.id, record);
  }
  return map;
}

function mergeOdometer(ocr, vlm) {
  // The model says the photo is not an odometer at all: trust that over any
  // digits the OCR found on a screenshot.
  const notOdometer = vlm.legivel === false && vlm.valor_lido == null;
  return {
    valor_lido: notOdometer ? null : ocr.valor_lido,
    confianca: ocr.confianca,
    legivel: !notOdometer && ocr.legivel,
    sinais_fraude: Boolean(vlm.sinais_fraude),
    motivos_fraude: vlm.motivos_fraude ?? [],
    observacao: `hibrido: ${ocr.observacao} / ${vlm.observacao ?? ""}`.slice(0, 400),
  };
}

function mergeProof(ocr, vlm, dateFallback) {
  return {
    e_canhoto: ocr.e_canhoto === "sim" ? "sim" : vlm.e_canhoto,
    numero_documento_lido: ocr.numero_documento_lido,
    data_recebimento_lida:
      ocr.data_recebimento_lida ?? (dateFallback === "vlm" ? vlm.data_recebimento_lida ?? null : null),
    tem_assinatura: vlm.tem_assinatura,
    nome_recebedor_lido: ocr.nome_recebedor_lido ?? vlm.nome_recebedor_lido ?? null,
    legivel: ocr.legivel === "sim" ? "sim" : vlm.legivel,
    qualidade_foto: vlm.qualidade_foto,
    confianca: vlm.confianca,
    observacao: `hibrido: ${ocr.observacao} / ${vlm.observacao ?? ""}`.slice(0, 400),
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const ocrRun = latest(path.join(args.ocr, "results.jsonl"));
  const vlmRun = latest(path.join(args.vlm, "results.jsonl"));
  const ocrInfo = JSON.parse(fs.readFileSync(path.join(args.ocr, "run.json"), "utf8"));
  const vlmInfo = JSON.parse(fs.readFileSync(path.join(args.vlm, "run.json"), "utf8"));

  fs.mkdirSync(args.out, { recursive: true });
  const lines = [];

  for (const [id, vlm] of vlmRun) {
    const ocr = ocrRun.get(id);
    if (!ocr || ocr.error || vlm.error || !ocr.parsed || !vlm.parsed) continue;

    const isOdometer = "valor_lido" in ocr.parsed && "valor_lido" in vlm.parsed;
    const parsed =
      vlm.task === "proof"
        ? mergeProof(ocr.parsed, vlm.parsed, args.dateFallback)
        : isOdometer
          ? mergeOdometer(ocr.parsed, vlm.parsed)
          : vlm.parsed;

    lines.push(
      JSON.stringify({
        id,
        task: vlm.task,
        variant: "prod",
        provider: "hybrid",
        model: `${ocrInfo.model} + ${vlmInfo.model}`,
        wallMs: ocr.wallMs + vlm.wallMs,
        ocrMs: ocr.wallMs,
        vlmMs: vlm.wallMs,
        inputTokens: null,
        outputTokens: null,
        rawText: JSON.stringify(parsed),
        parsed,
        jsonValid: true,
      }),
    );
  }

  fs.writeFileSync(path.join(args.out, "results.jsonl"), `${lines.join("\n")}\n`);
  fs.writeFileSync(path.join(args.out, "samples.jsonl"), "");
  fs.writeFileSync(
    path.join(args.out, "run.json"),
    `${JSON.stringify(
      {
        provider: "hybrid",
        model: `${ocrInfo.model} + ${vlmInfo.model}`,
        sources: { ocr: path.basename(args.ocr), vlm: path.basename(args.vlm) },
        dateFallback: args.dateFallback,
        variants: ["prod"],
        segments: [{ argv: process.argv.slice(2) }],
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${lines.length} merged items -> ${args.out}`);
}

main();
