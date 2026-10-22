/**
 * Builds the labeled benchmark set: synthetic photos rendered by Chromium
 * (scenes.mjs) plus the real app uploads found in trajetto-api/tmp, all
 * re-encoded the way the app encodes a photo before upload
 * (trajetto-mobile/features/media/prepare-image.ts: JPEG, longest side
 * <= 1600 px, quality 0.72).
 *
 *   node scripts/ai-benchmark/generate-dataset.mjs --dir <out> [--real-root tmp] [--variations]
 *
 * --variations adds the harder captures of 10/2026 (VARIATIONS below: other
 * handwriting, strong skew, motion blur, low light, a receipt dated another
 * day) after the 44 original items, whose ids and pixels stay the same.
 *
 * Writes <out>/images/*.jpg and <out>/labels.json.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  BACKGROUNDS,
  cardboardBox,
  crackedWindshield,
  digitalCluster,
  drumCluster,
  fireExtinguisher,
  fuelCluster,
  nfceCoupon,
  phoneShowingCluster,
  receiptStub,
  scene,
  tyreTread,
} from "./scenes.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(here, "../..");

function parseArgs(argv) {
  const args = {
    dir: path.join(apiRoot, "tmp/ai-benchmark"),
    realRoot: path.join(apiRoot, "tmp"),
    variations: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = path.resolve(argv[++i]);
    else if (argv[i] === "--variations") args.variations = true;
    else if (argv[i] === "--real-root") args.realRoot = path.resolve(argv[++i]);
  }
  return args;
}

/**
 * Playwright is a dependency of trajetto-ui, not of the API. The benchmark
 * borrows it instead of adding a browser to the API's dependency tree.
 */
function loadPlaywright() {
  const candidates = [
    import.meta.url,
    path.resolve(apiRoot, "../trajetto-ui/package.json"),
  ];
  for (const candidate of candidates) {
    try {
      return createRequire(candidate)("playwright");
    } catch {
      // try the next location
    }
  }
  throw new Error(
    "playwright not found: install it (npm i -D playwright) or keep ../trajetto-ui/node_modules",
  );
}

// ---------------------------------------------------------------------------
// The set. `truth` is the ground truth a person would give for the photo.
// ---------------------------------------------------------------------------

const LANDSCAPE = { width: 1600, height: 1200 };
const PORTRAIT = { width: 1200, height: 1600 };

const PROOF_CONTEXT = {
  expectedDocument: "45181",
  expectedRecipient: "Mercado Boa Vista Ltda",
  provenOn: "2026-09-27",
};

const paperLight =
  "linear-gradient(105deg, #ffffff 0%, #ffffff 55%, #c9c3b8 100%)";
const handShadow =
  "radial-gradient(ellipse at 88% 95%, #6f695f 0%, #ffffff 48%)";
const crumpled = `radial-gradient(circle at 20% 30%, #d9d4ca 0%, #fff 22%), radial-gradient(circle at 70% 60%, #d2cdc2 0%, #fff 25%), radial-gradient(circle at 45% 85%, #cfc9be 0%, #fff 20%)`;

function proof(id, description, options, truth, look = {}) {
  return {
    id,
    task: "proof",
    source: "synthetic",
    description,
    input: PROOF_CONTEXT,
    truth,
    render: {
      ...LANDSCAPE,
      html: scene({
        ...LANDSCAPE,
        background: BACKGROUNDS.wood,
        subject:
          options.custom ??
          receiptStub({
            seed: id.charCodeAt(1) * 31 + Number(id.slice(1)),
            ...options,
          }),
        ...look,
      }),
    },
  };
}

const RECEIPT_OK = {
  isReceipt: "yes",
  legible: "yes",
  hasSignature: "yes",
  dateVisible: "yes",
  documentMatches: "yes",
  printedNumber: "45181",
  expected: "looks_good",
};

const PROOFS = [
  proof(
    "P01",
    "Canhoto correto, plano, boa luz",
    {
      nf: "000.045.181",
      date: "27/09/2026",
      signature: true,
      signer: "Carla M. Souza",
    },
    RECEIPT_OK,
    { transform: "rotate(-1.2deg) scale(1.08)", light: paperLight },
  ),
  proof(
    "P02",
    "Canhoto correto, girado, sombra da mão, leve desfoque",
    { nf: "000.045.181", date: "27/09/2026", signature: true },
    RECEIPT_OK,
    {
      transform: "perspective(1800px) rotateX(10deg) rotateZ(4deg) scale(1.02)",
      light: handShadow,
      filter: "blur(0.8px)",
    },
  ),
  proof(
    "P03",
    "Canhoto correto ainda preso à DANFE, em perspectiva",
    {
      nf: "000.045.181",
      date: "27/09/2026",
      signature: true,
      signer: "R. Almeida",
      fullDanfe: true,
    },
    RECEIPT_OK,
    {
      transform: "perspective(1800px) rotateX(16deg) rotateZ(-2deg) scale(1.1)",
      light: paperLight,
    },
  ),
  proof(
    "P04",
    "Canhoto correto, pouca luz e papel amassado",
    { nf: "000.045.181", date: "27/09/26", signature: true },
    RECEIPT_OK,
    {
      transform: "rotate(2deg) scale(1.05)",
      light: crumpled,
      filter: "brightness(.66) contrast(.9) sepia(.25)",
    },
  ),
  proof(
    "P05",
    "Canhoto correto, data curta e nome legível",
    {
      nf: "000.045.181",
      date: "27/09/26",
      signature: true,
      signer: "José Pereira",
    },
    RECEIPT_OK,
    { transform: "rotate(-3deg) scale(1.05)", light: paperLight },
  ),
  proof(
    "P06",
    "Número trocado (045.118 em vez de 045.181)",
    {
      nf: "000.045.118",
      date: "27/09/2026",
      signature: true,
      signer: "Carla M. Souza",
    },
    {
      ...RECEIPT_OK,
      documentMatches: "no",
      printedNumber: "45118",
      expected: "looks_wrong",
    },
    { transform: "rotate(1.5deg) scale(1.08)", light: paperLight },
  ),
  proof(
    "P07",
    "Outra nota (000.112.907), DANFE inteira",
    { nf: "000.112.907", date: "27/09/2026", signature: true, fullDanfe: true },
    {
      ...RECEIPT_OK,
      documentMatches: "no",
      printedNumber: "112907",
      expected: "looks_wrong",
    },
    {
      transform: "perspective(1800px) rotateX(12deg) rotateZ(1deg) scale(1.1)",
      light: handShadow,
    },
  ),
  proof(
    "P08",
    "Sem data de recebimento",
    {
      nf: "000.045.181",
      date: null,
      signature: true,
      signer: "Carla M. Souza",
    },
    { ...RECEIPT_OK, dateVisible: "no", expected: "looks_wrong" },
    { transform: "rotate(-2deg) scale(1.08)", light: paperLight },
  ),
  proof(
    "P09",
    "Sem data, DANFE inteira",
    { nf: "000.045.181", date: null, signature: true, fullDanfe: true },
    { ...RECEIPT_OK, dateVisible: "no", expected: "looks_wrong" },
    {
      transform: "perspective(1800px) rotateX(14deg) rotateZ(-3deg) scale(1.1)",
      light: paperLight,
    },
  ),
  proof(
    "P10",
    "Sem assinatura (só a data)",
    { nf: "000.045.181", date: "27/09/2026", signature: false },
    { ...RECEIPT_OK, hasSignature: "no", expected: "looks_wrong" },
    { transform: "rotate(1deg) scale(1.08)", light: paperLight },
  ),
  proof(
    "P11",
    "Sem assinatura, girado e desfocado",
    { nf: "000.045.181", date: "27/09/2026", signature: false },
    { ...RECEIPT_OK, hasSignature: "no", expected: "looks_wrong" },
    {
      transform: "rotate(6deg) scale(1.02)",
      light: handShadow,
      filter: "blur(0.7px)",
    },
  ),
  proof(
    "P12",
    "Canhoto em branco (sem data e sem assinatura)",
    { nf: "000.045.181", date: null, signature: false },
    {
      ...RECEIPT_OK,
      hasSignature: "no",
      dateVisible: "no",
      expected: "looks_wrong",
    },
    { transform: "rotate(-1deg) scale(1.08)", light: paperLight },
  ),
  proof(
    "P13",
    "Canhoto correto mas ilegível (tremido e escuro)",
    { nf: "000.045.181", date: "27/09/2026", signature: true },
    {
      isReceipt: "yes",
      legible: "no",
      hasSignature: null,
      dateVisible: null,
      documentMatches: null,
      printedNumber: null,
      expected: "not_good",
    },
    {
      transform: "rotate(3deg) scale(1.05)",
      filter: "blur(7px) brightness(.45)",
      light: handShadow,
    },
  ),
  proof(
    "P14",
    "Não é canhoto: etiqueta da caixa (traz NF 45181)",
    { custom: cardboardBox(1414) },
    {
      isReceipt: "no",
      legible: null,
      hasSignature: "no",
      dateVisible: "no",
      documentMatches: null,
      printedNumber: null,
      expected: "not_good",
    },
    {
      background: BACKGROUNDS.cardboardFloor,
      transform: "perspective(1800px) rotateX(18deg) rotateZ(-4deg) scale(1.1)",
    },
  ),
  {
    ...proof(
      "P15",
      "Não é canhoto: cupom NFC-e de supermercado",
      { custom: nfceCoupon(1515) },
      {
        isReceipt: "no",
        legible: null,
        hasSignature: "no",
        dateVisible: null,
        documentMatches: "no",
        printedNumber: null,
        expected: "not_good",
      },
    ),
    render: {
      ...PORTRAIT,
      html: scene({
        ...PORTRAIT,
        background: BACKGROUNDS.wood,
        subject: nfceCoupon(1515),
        transform: "rotate(-4deg) scale(1.08)",
        light: paperLight,
      }),
    },
  },
];

function odometerScene(
  id,
  description,
  subject,
  input,
  truth,
  look = {},
  size = LANDSCAPE,
) {
  return {
    id,
    task: "odometer",
    source: "synthetic",
    description,
    input,
    truth,
    render: {
      ...size,
      html: scene({
        ...size,
        background: BACKGROUNDS.dashboard,
        subject,
        ...look,
      }),
    },
  };
}

const glare = `<div class="overlay" style="background:radial-gradient(ellipse 420px 180px at 62% 38%, rgba(255,255,255,.55), transparent 70%)"></div>`;

const ODOMETERS = [
  odometerScene(
    "O01",
    "Painel digital LCD, leitura clara",
    digitalCluster({ odo: "084312" }),
    { reportedMileage: 84312 },
    { reading: 84312, expected: ["verified"] },
    { transform: "scale(1.02)" },
  ),
  odometerScene(
    "O02",
    "Painel âmbar em ângulo; informado 5 km acima",
    digitalCluster({ odo: "127845", style: "amber", clock: "18:05" }),
    { reportedMileage: 127850 },
    { reading: 127845, expected: ["verified"] },
    {
      transform: "perspective(1600px) rotateY(-14deg) rotateX(6deg) scale(.98)",
    },
  ),
  odometerScene(
    "O03",
    "Odômetro mecânico de tambor",
    drumCluster({ odo: "056719", trip: "0345", seed: 3 }),
    { reportedMileage: 56719 },
    { reading: 56719, expected: ["verified"] },
    { transform: "rotate(-4deg) scale(1.1)" },
  ),
  odometerScene(
    "O04",
    "Trip em destaque, ODO pequeno (distrator)",
    digitalCluster({
      odo: "203118",
      trip: "345.6",
      style: "blue",
      tripBig: true,
      clock: "06:58",
    }),
    { reportedMileage: 203118 },
    { reading: 203118, expected: ["verified"] },
    { transform: "scale(1.02)" },
  ),
  odometerScene(
    "O05",
    "LCD com reflexo e inclinação",
    digitalCluster({ odo: "098765", clock: "12:31" }),
    { reportedMileage: 98765 },
    { reading: 98765, expected: ["verified"] },
    { transform: "rotate(-5deg) scale(1.02)", extra: glare },
  ),
  odometerScene(
    "O06",
    "Leitura 84.312, informado 94.312 (divergente)",
    digitalCluster({ odo: "084312", clock: "09:14" }),
    { reportedMileage: 94312 },
    { reading: 84312, expected: ["mismatch"] },
    { transform: "perspective(1600px) rotateY(10deg) scale(1)" },
  ),
  odometerScene(
    "O07",
    "Tambor 145.002, informado 154.002 (divergente)",
    drumCluster({ odo: "145002", trip: "0781", seed: 7 }),
    { reportedMileage: 154002 },
    { reading: 145002, expected: ["mismatch"] },
    { transform: "rotate(3deg) scale(1.1)" },
  ),
  odometerScene(
    "O08",
    "Painel de caminhão âmbar",
    digitalCluster({
      odo: "412530",
      style: "amber",
      speedMax: 140,
      clock: "05:47",
    }),
    { reportedMileage: 412530 },
    { reading: 412530, expected: ["verified"] },
    { transform: "scale(1.02)" },
  ),
  odometerScene(
    "O09",
    "Foto de tela (galeria de outro celular) — fraude",
    phoneShowingCluster(digitalCluster({ odo: "076540" })),
    { reportedMileage: 76540 },
    { reading: 76540, expected: ["fraud"] },
    { background: BACKGROUNDS.wood, transform: "rotate(-6deg) scale(.98)" },
    PORTRAIT,
  ),
  odometerScene(
    "O10",
    "Tremida demais para ler",
    digitalCluster({ odo: "061288" }),
    { reportedMileage: 61288 },
    { reading: null, expected: ["unreadable"] },
    { transform: "scale(1.02)", filter: "blur(9px) brightness(.55)" },
  ),
  odometerScene(
    "O11",
    "Noite, painel azul com pouca luz",
    digitalCluster({ odo: "031207", style: "blue", clock: "22:16" }),
    { reportedMileage: 31207 },
    { reading: 31207, expected: ["verified"] },
    {
      transform: "rotate(2deg) scale(1.02)",
      filter: "brightness(.6)",
      vignette: 0.75,
    },
  ),
];

function checklistScene(
  id,
  description,
  fieldName,
  fieldValue,
  subject,
  truth,
  look = {},
  size = LANDSCAPE,
) {
  return {
    id,
    task: "checklist",
    source: "synthetic",
    description,
    input: { fieldName, fieldValue },
    truth,
    render: {
      ...size,
      html: scene({
        ...size,
        background: BACKGROUNDS.dashboard,
        subject,
        ...look,
      }),
    },
  };
}

const CHECKLISTS = [
  checklistScene(
    "K01",
    "Odômetro do checklist, confere",
    "current_mileage",
    150233,
    digitalCluster({ odo: "150233", clock: "06:40" }),
    { expectedMatch: true, reading: 150233 },
    { transform: "scale(1.02)" },
  ),
  checklistScene(
    "K02",
    "Odômetro do checklist, informado 105.233 (não confere)",
    "current_mileage",
    105233,
    digitalCluster({ odo: "150233", style: "amber", clock: "06:44" }),
    { expectedMatch: false, reading: 150233 },
    { transform: "rotate(-3deg) scale(1.02)" },
  ),
  checklistScene(
    "K03",
    "Tanque cheio, informado adequado",
    "fuel_level_adequate",
    true,
    fuelCluster({ level: 1, warning: false }),
    { expectedMatch: true, level: "cheio" },
    { transform: "scale(1.05)" },
  ),
  checklistScene(
    "K04",
    "Reserva com luz acesa, informado adequado",
    "fuel_level_adequate",
    true,
    fuelCluster({ level: 0.04, warning: true }),
    { expectedMatch: false, level: "reserva" },
    { transform: "rotate(2deg) scale(1.05)" },
  ),
  checklistScene(
    "K05",
    "3/4 de tanque, informado NÃO adequado",
    "fuel_level_adequate",
    false,
    fuelCluster({ level: 0.75, warning: false }),
    { expectedMatch: false, level: "tres_quartos" },
    { transform: "perspective(1600px) rotateY(-10deg) scale(1.02)" },
  ),
  checklistScene(
    "K06",
    "Reserva com luz acesa, informado NÃO adequado",
    "fuel_level_adequate",
    false,
    fuelCluster({ level: 0.08, warning: true }),
    { expectedMatch: true, level: "reserva" },
    { transform: "rotate(-2deg) scale(1.05)" },
  ),
  checklistScene(
    "K07",
    "Pneu novo, informado good",
    "tires_condition",
    "good",
    tyreTread({ worn: false, seed: 71 }),
    { expectedMatch: true, condition: "good" },
    {
      background: BACKGROUNDS.asphalt,
      transform: "perspective(1600px) rotateX(28deg) scale(.95)",
    },
    PORTRAIT,
  ),
  checklistScene(
    "K08",
    "Pneu careca com corte até a malha de aço, informado good",
    "tires_condition",
    "good",
    tyreTread({ worn: true, seed: 81 }),
    { expectedMatch: false, condition: "bad" },
    {
      background: BACKGROUNDS.asphalt,
      transform: "perspective(1600px) rotateX(28deg) scale(.95)",
    },
    PORTRAIT,
  ),
  checklistScene(
    "K09",
    "Pneu careca com corte, informado bad",
    "tires_condition",
    "bad",
    tyreTread({ worn: true, seed: 91 }),
    { expectedMatch: true, condition: "bad" },
    {
      background: BACKGROUNDS.asphalt,
      transform: "perspective(1600px) rotateX(22deg) rotateZ(-4deg) scale(.95)",
    },
    PORTRAIT,
  ),
  checklistScene(
    "K10",
    "Para-brisa trincado, informado good (prompt padrão)",
    "windshield_condition",
    "good",
    crackedWindshield(10),
    { expectedMatch: false, condition: "bad" },
    { transform: "scale(1)" },
  ),
  checklistScene(
    "K11",
    "Extintor com manômetro no verde e validade 08/2027, informado true (prompt padrão)",
    "fire_extinguisher_valid",
    true,
    fireExtinguisher(),
    { expectedMatch: true, condition: "good" },
    { background: BACKGROUNDS.carpet, transform: "rotate(-8deg) scale(1)" },
    PORTRAIT,
  ),
];

/**
 * Harder captures (10/2026), opt-in with --variations: what a phone in a
 * truck cab really produces. Other handwriting (Segoe Script, smaller and more
 * tilted), strong perspective, motion blur, low light, and a receipt dated a
 * week before the delivery (the date is there but is not the day: "no").
 */
const motionBlur = "blur(1.4px) brightness(.62) contrast(.92)";

const VARIATIONS = [
  proof(
    "P16",
    "Canhoto correto, outra letra, muito inclinado, pouca luz e tremido",
    {
      nf: "000.045.181",
      date: "27/09/26",
      signature: true,
      signer: "Ana P. Lima",
      handFont: "'Segoe Script', 'Ink Free', cursive",
      dateSize: 32,
      dateTilt: -7,
    },
    RECEIPT_OK,
    {
      transform: "perspective(1500px) rotateX(24deg) rotateZ(-8deg) scale(1.0)",
      light: handShadow,
      filter: motionBlur,
    },
  ),
  proof(
    "P17",
    "Canhoto correto, data com hífen, só a rubrica, reflexo de flash e leve desfoque",
    {
      nf: "000.045.181",
      date: "27-09-2026",
      signature: true,
      handFont: "'Segoe Print', cursive",
      dateSize: 30,
      dateTilt: 4,
    },
    RECEIPT_OK,
    {
      transform: "rotate(-5deg) scale(1.04)",
      light: paperLight,
      filter: "blur(1.1px)",
      extra: `<div class="overlay" style="background:radial-gradient(ellipse 380px 220px at 40% 45%, rgba(255,255,255,.75), transparent 70%)"></div>`,
    },
  ),
  proof(
    "P18",
    "Data de recebimento de outro dia (20/09/2026)",
    {
      nf: "000.045.181",
      date: "20/09/2026",
      signature: true,
      signer: "Carla M. Souza",
    },
    { ...RECEIPT_OK, dateVisible: "no", expected: "looks_wrong" },
    { transform: "rotate(2deg) scale(1.06)", light: paperLight },
  ),
  proof(
    "P19",
    "Só a assinatura, sem data, pouca luz",
    {
      nf: "000.045.181",
      date: null,
      signature: true,
      handFont: "'Segoe Script', cursive",
    },
    { ...RECEIPT_OK, dateVisible: "no", expected: "looks_wrong" },
    {
      transform: "rotate(-3deg) scale(1.05)",
      light: crumpled,
      filter: "brightness(.5) contrast(.95)",
      vignette: 0.7,
    },
  ),
  proof(
    "P20",
    "Número trocado (045.811), perspectiva forte e desfoque",
    {
      nf: "000.045.811",
      date: "27/09/2026",
      signature: true,
      signer: "R. Almeida",
    },
    {
      ...RECEIPT_OK,
      documentMatches: "no",
      printedNumber: "45811",
      expected: "looks_wrong",
    },
    {
      transform: "perspective(1400px) rotateY(-22deg) rotateX(8deg) scale(1.0)",
      light: handShadow,
      filter: "blur(1px)",
    },
  ),
  odometerScene(
    "O12",
    "Tambor tremido e com pouca luz",
    drumCluster({ odo: "087654", trip: "0123", seed: 12 }),
    { reportedMileage: 87654 },
    { reading: 87654, expected: ["verified"] },
    {
      transform: "rotate(-6deg) scale(1.08)",
      filter: "blur(1.8px) brightness(.55)",
      vignette: 0.7,
    },
  ),
  odometerScene(
    "O13",
    "LCD em perspectiva forte (foto de lado)",
    digitalCluster({ odo: "223344", clock: "15:02" }),
    { reportedMileage: 223344 },
    { reading: 223344, expected: ["verified"] },
    {
      transform: "perspective(1200px) rotateY(32deg) rotateX(-6deg) scale(.95)",
    },
  ),
  odometerScene(
    "O14",
    "Painel âmbar à noite, muito escuro",
    digitalCluster({ odo: "309871", style: "amber", clock: "23:48" }),
    { reportedMileage: 309871 },
    { reading: 309871, expected: ["verified"] },
    {
      transform: "rotate(3deg) scale(1.02)",
      filter: "brightness(.42)",
      vignette: 0.85,
    },
  ),
  checklistScene(
    "K12",
    "1/4 de tanque com pouca luz, informado adequado",
    "fuel_level_adequate",
    true,
    fuelCluster({ level: 0.25, warning: false }),
    { expectedMatch: true, level: "um_quarto" },
    {
      transform: "rotate(-3deg) scale(1.05)",
      filter: "brightness(.55)",
      vignette: 0.75,
    },
  ),
  checklistScene(
    "K13",
    "Pneu novo com pouca luz e desfoque, informado good",
    "tires_condition",
    "good",
    tyreTread({ worn: false, seed: 131 }),
    { expectedMatch: true, condition: "good" },
    {
      background: BACKGROUNDS.asphalt,
      transform: "perspective(1600px) rotateX(30deg) rotateZ(5deg) scale(.95)",
      filter: "blur(1.2px) brightness(.6)",
    },
    PORTRAIT,
  ),
];

/**
 * Real uploads from the dev environment (trajetto-api/tmp). None of them is
 * the object the field asked for — which is exactly what a careless or
 * dishonest driver sends. Photos showing people or personal documents in that
 * folder are deliberately NOT used.
 */
const REAL = [
  {
    id: "RP1",
    task: "proof",
    file: "deliveryPhotos/01a05ae1-17a1-7522-bf8e-1add8345d4ee/1790215587952-8509725d-8b9b-4c82-868e-cd283429184-235afac7.jpg",
    description: "Upload real: imagem de 'bom dia' no lugar do canhoto",
    input: PROOF_CONTEXT,
    truth: {
      isReceipt: "no",
      legible: null,
      hasSignature: "no",
      dateVisible: "no",
      documentMatches: "no",
      printedNumber: null,
      expected: "not_good",
    },
  },
  {
    id: "RP2",
    task: "proof",
    file: "deliveryPhotos/01a05ae1-17a1-7522-bf8e-1add8345d4ee/1790215587952-1b7c7f62-1b07-4865-a303-bad58647f4a-f68e74fd.png",
    description: "Upload real: só um rabisco de assinatura em papel branco",
    input: PROOF_CONTEXT,
    truth: {
      isReceipt: "no",
      legible: null,
      hasSignature: null,
      dateVisible: "no",
      documentMatches: "no",
      printedNumber: null,
      expected: "not_good",
    },
  },
  {
    id: "RO1",
    task: "odometer",
    file: "odometerPhotos/01a001cc-8d2a-7973-9283-87e8f435f210/1786768267191-odometer-a2fa97fd-fdd0-4df8-9990-73-9b690c52.jpg",
    description: "Upload real: imagem de 'bom dia' no lugar do odômetro",
    input: { reportedMileage: 45210 },
    truth: { reading: null, expected: ["unreadable", "fraud"] },
  },
  {
    id: "RO2",
    task: "odometer",
    file: "odometerPhotos/01a001cc-8d2a-7973-9283-87e8f435f210/1786842349739-odometer_photo_1786842349650_0-b47aaf0d.webp",
    description: "Upload real: print de benchmark de GPU no lugar do odômetro",
    input: { reportedMileage: 45210 },
    truth: { reading: null, expected: ["unreadable", "fraud"] },
  },
  {
    id: "RO3",
    task: "odometer",
    file: "odometerPhotos/01a001cc-8d2a-7973-9283-87e8f435f210/1786816763271-odometer-83cbbe74-e838-4b1c-a032-87-c4cb619d.jpg",
    description: "Upload real: foto escura de tecido",
    input: { reportedMileage: 45210 },
    truth: { reading: null, expected: ["unreadable", "fraud"] },
  },
  {
    id: "RK1",
    task: "checklist",
    file: "checklistPhotos/01a001cc-8d2a-7973-9283-87e8f435f210/1786767034136-tires_condition_1786767033957_0-40ec7913.webp",
    description:
      "Upload real: print de benchmark com placar 5339, informado 5339 km",
    input: { fieldName: "current_mileage", fieldValue: 5339 },
    truth: { expectedMatch: false, reading: null },
  },
  {
    id: "RK2",
    task: "checklist",
    file: "checklistPhotos/01a001cc-8d2a-7973-9283-87e8f435f210/1786767498576-fuel_level_adequate-f768f79c-34f1-4-bfac1b2d.jpg",
    description:
      "Upload real: imagem de flores no lugar do marcador de combustível",
    input: { fieldName: "fuel_level_adequate", fieldValue: true },
    truth: { expectedMatch: false, level: "ilegivel" },
  },
];

const MAX_SIDE = 1600;
const JPEG_QUALITY = 72;

async function renderSynthetic(page, item, outFile) {
  await page.setViewportSize({
    width: item.render.width,
    height: item.render.height,
  });
  await page.setContent(item.render.html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: outFile, type: "jpeg", quality: JPEG_QUALITY });
}

async function renderReal(page, sourceFile, outFile) {
  const ext = path
    .extname(sourceFile)
    .slice(1)
    .toLowerCase()
    .replace("jpg", "jpeg");
  const data = fs.readFileSync(sourceFile).toString("base64");

  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(
    `<body style="margin:0"><img id="photo" src="data:image/${ext};base64,${data}"></body>`,
    { waitUntil: "load" },
  );
  const size = await page.evaluate(() => {
    const img = document.getElementById("photo");
    return { width: img.naturalWidth, height: img.naturalHeight };
  });

  const scale = Math.min(1, MAX_SIDE / Math.max(size.width, size.height));
  const width = Math.round(size.width * scale);
  const height = Math.round(size.height * scale);

  await page.setViewportSize({ width, height });
  await page.evaluate(
    ({ w, h }) => {
      const img = document.getElementById("photo");
      img.style.width = `${w}px`;
      img.style.height = `${h}px`;
      img.style.display = "block";
    },
    { w: width, h: height },
  );
  await page.screenshot({ path: outFile, type: "jpeg", quality: JPEG_QUALITY });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const imagesDir = path.join(args.dir, "images");
  fs.mkdirSync(imagesDir, { recursive: true });

  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const labels = [];

  for (const item of [...PROOFS, ...ODOMETERS, ...CHECKLISTS]) {
    const file = `images/${item.id}.jpg`;
    await renderSynthetic(page, item, path.join(args.dir, file));
    const { render, ...label } = item;
    labels.push({ ...label, file, width: render.width, height: render.height });
    process.stdout.write(`${item.id} `);
  }

  for (const item of args.variations ? VARIATIONS : []) {
    const file = `images/${item.id}.jpg`;
    await renderSynthetic(page, item, path.join(args.dir, file));
    const { render, ...label } = item;
    labels.push({
      ...label,
      variation: true,
      file,
      width: render.width,
      height: render.height,
    });
    process.stdout.write(`${item.id} `);
  }

  for (const item of REAL) {
    const source = path.join(args.realRoot, item.file);
    if (!fs.existsSync(source)) {
      console.warn(
        `\nskipping ${item.id}: ${item.file} not found under ${args.realRoot}`,
      );
      continue;
    }
    const file = `images/${item.id}.jpg`;
    await renderReal(page, source, path.join(args.dir, file));
    labels.push({ ...item, source: "real-upload", origin: item.file, file });
    process.stdout.write(`${item.id} `);
  }

  await browser.close();

  fs.writeFileSync(
    path.join(args.dir, "labels.json"),
    `${JSON.stringify(labels, null, 2)}\n`,
  );
  console.log(`\n${labels.length} images -> ${args.dir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
