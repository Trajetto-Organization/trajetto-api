/**
 * HTML/SVG scenes for the synthetic part of the benchmark set.
 *
 * Every scene is a "photo" of a real object the product receives: an NF-e
 * receipt stub, an instrument cluster, a fuel gauge, a tyre tread. They are
 * rendered by Chromium and then degraded the way a phone camera degrades
 * them (perspective, shadow, uneven light, blur, grain, JPEG), because a model
 * that only ever sees clean vector art would look better here than it will on
 * a driver's photo. Names, CNPJs and addresses are fictitious.
 */

// ---------------------------------------------------------------------------
// Deterministic randomness: the same seed always renders the same image, so a
// re-run on a quiet machine measures the exact same set.
// ---------------------------------------------------------------------------

function seeded(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function noiseUrl(opacity = 0.5, frequency = 0.85, octaves = 3) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='320' height='320'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='${frequency}' numOctaves='${octaves}' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(#n)' opacity='${opacity}'/></svg>`;

  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
}

const BACKGROUNDS = {
  wood: `${noiseUrl(0.35, 0.02, 2)}, repeating-linear-gradient(93deg, #6b4a2e 0 14px, #74513a 14px 22px, #5f4128 22px 41px, #6e4c30 41px 57px)`,
  dashboard: `${noiseUrl(0.25, 0.9)}, radial-gradient(ellipse at 50% 40%, #2b2e33 0%, #121315 60%, #060607 100%)`,
  asphalt: `${noiseUrl(0.9, 1.4, 4)}, #3a3a3a`,
  seat: `${noiseUrl(0.6, 0.6, 3)}, linear-gradient(160deg, #5d636b, #3e434a)`,
  carpet: `${noiseUrl(0.8, 1.1, 4)}, #2a2b2e`,
  cardboardFloor: `${noiseUrl(0.5, 0.7, 3)}, linear-gradient(180deg, #8d8a84, #6c6964)`,
};

/**
 * One photographed scene: subject in the middle, then the camera's faults on
 * top of it. `light` is a multiply layer (uneven lighting, a hand's shadow).
 */
function scene({
  width,
  height,
  background,
  subject,
  transform = "",
  filter = "none",
  light = "none",
  grain = 0.18,
  vignette = 0.35,
  extra = "",
}) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden;background:#000}
    .scene{position:relative;width:100%;height:100%;overflow:hidden;background:${background};filter:${filter}}
    .subject{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%) ${transform};transform-origin:center}
    .overlay{position:absolute;inset:0;pointer-events:none}
  </style></head><body><div class="scene">
    <div class="subject">${subject}</div>
    <div class="overlay" style="background:${light};mix-blend-mode:multiply"></div>
    <div class="overlay" style="background-image:${noiseUrl(1, 1.6, 2)};opacity:${grain};mix-blend-mode:overlay"></div>
    <div class="overlay" style="background:radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,${vignette}) 100%)"></div>
    ${extra}
  </div></body></html>`;
}

// ---------------------------------------------------------------------------
// NF-e receipt stub (canhoto) and DANFE header
// ---------------------------------------------------------------------------

const HAND_FONT = "'Ink Free', 'Segoe Print', 'Comic Sans MS', cursive";
const INK = "#1f3d8f";

function signatureSvg(seed, { left = 70, top = 22 } = {}) {
  const random = seeded(seed);
  let x = 24;
  let y = 76;
  let d = `M ${x} ${y}`;
  const strokes = 7 + Math.floor(random() * 4);

  for (let i = 0; i < strokes; i++) {
    const dx = 32 + random() * 42;
    const rise = 30 + random() * 42;
    const c1x = x + dx * 0.2;
    const c1y = y - rise * (0.8 + random() * 0.6);
    const c2x = x + dx * (0.9 + random() * 0.4);
    const c2y = y - rise * (0.4 + random() * 0.8);
    x += dx;
    y = 76 + (random() - 0.5) * 24;
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${x.toFixed(1)} ${y.toFixed(1)}`;

    if (random() > 0.55) {
      d += ` C ${(x + 16).toFixed(1)} ${(y + 30 + random() * 18).toFixed(1)}, ${(x - 14 - random() * 16).toFixed(1)} ${(y + 38 + random() * 20).toFixed(1)}, ${(x + 6).toFixed(1)} ${(y - 4).toFixed(1)}`;
      x += 6;
      y -= 4;
    }
  }

  d += ` M ${(30 + random() * 20).toFixed(1)} ${(104 + random() * 8).toFixed(1)} Q ${(x / 2).toFixed(1)} ${(124 + random() * 16).toFixed(1)}, ${(x + 28).toFixed(1)} ${(94 + random() * 8).toFixed(1)}`;

  const width = Math.ceil(x + 60);

  return `<svg width="${width}" height="140" viewBox="0 0 ${width} 140" style="position:absolute;left:${left}px;top:${top}px"><path d="${d}" fill="none" stroke="${INK}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" opacity=".9"/></svg>`;
}

function barcodeSvg(seed, width = 520, height = 58) {
  const random = seeded(seed);
  let x = 0;
  let bars = "";

  while (x < width - 6) {
    const bar = 1 + Math.floor(random() * 4);
    const gap = 1 + Math.floor(random() * 3);
    bars += `<rect x="${x}" y="0" width="${bar}" height="${height}" fill="#111"/>`;
    x += bar + gap;
  }

  return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${bars}</svg>`;
}

/** 44-digit access key whose nNF field carries the printed number. */
function accessKey(nfDigits) {
  const nNF = nfDigits.padStart(9, "0");
  const raw = `35260912345678000190550010${nNF}1${nNF.slice(-8)}`;
  const withDv = `${raw}${raw.split("").reduce((sum, digit) => sum + Number(digit), 0) % 10}`;

  return withDv.match(/.{1,4}/g).join(" ");
}

const RECEIPT_DEFAULTS = {
  emitente: "DISTRIBUIDORA ALIANÇA DE ALIMENTOS LTDA",
  destinatario: "MERCADO BOA VISTA LTDA",
  endereco: "AV. DAS AMOREIRAS, 1450 - JARDIM PROFESSORA TARCÍLIA - CAMPINAS/SP",
  emissao: "25/09/2026",
  valor: "R$ 3.482,90",
  serie: "1",
};

function danfeHeader({ nf, serie, emitente, destinatario, endereco, emissao, seed }) {
  const nfDigits = nf.replace(/\D/g, "");
  const cell = "border:1.6px solid #222;padding:6px 9px;vertical-align:top";

  return `<div style="margin-top:18px">
    <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px">
      <tr>
        <td style="width:42%;${cell};height:186px">
          <div style="font-size:11px">IDENTIFICAÇÃO DO EMITENTE</div>
          <div style="font-size:21px;font-weight:bold;margin-top:10px">${emitente}</div>
          <div style="margin-top:6px">RUA DOS BANDEIRANTES, 820 - GALPÃO 3</div>
          <div>DISTRITO INDUSTRIAL - CAMPINAS - SP - CEP 13054-000</div>
          <div>Fone: (19) 3232-4455</div>
        </td>
        <td style="width:19%;${cell};text-align:center">
          <div style="font-size:26px;font-weight:bold">DANFE</div>
          <div style="font-size:11px">Documento Auxiliar da Nota Fiscal Eletrônica</div>
          <div style="font-size:12px;margin-top:6px">0 - ENTRADA<br>1 - SAÍDA <span style="border:1.5px solid #222;padding:0 6px;font-weight:bold">1</span></div>
          <div style="font-size:15px;font-weight:bold;margin-top:8px">Nº ${nf}<br>SÉRIE ${serie}</div>
          <div style="font-size:11px">FOLHA 1/1</div>
        </td>
        <td style="${cell}">
          ${barcodeSvg(seed + 7)}
          <div style="font-size:11px;margin-top:4px">CHAVE DE ACESSO</div>
          <div style="font-size:14px;font-weight:bold;letter-spacing:.4px">${accessKey(nfDigits)}</div>
          <div style="font-size:11px;margin-top:6px">Consulta de autenticidade no portal nacional da NF-e www.nfe.fazenda.gov.br/portal ou no site da Sefaz Autorizadora</div>
        </td>
      </tr>
      <tr>
        <td colspan="2" style="${cell}"><div style="font-size:11px">NATUREZA DA OPERAÇÃO</div><b>VENDA DE MERCADORIA ADQUIRIDA DE TERCEIROS</b></td>
        <td style="${cell}"><div style="font-size:11px">PROTOCOLO DE AUTORIZAÇÃO DE USO</div><b>135260912345678 - 25/09/2026 14:12:55</b></td>
      </tr>
      <tr>
        <td style="${cell}"><div style="font-size:11px">INSCRIÇÃO ESTADUAL</div><b>244.118.902.110</b></td>
        <td style="${cell}"><div style="font-size:11px">INSC. EST. SUBST. TRIB.</div><b>&nbsp;</b></td>
        <td style="${cell}"><div style="font-size:11px">CNPJ</div><b>12.345.678/0001-90</b></td>
      </tr>
    </table>
    <div style="font-size:12px;font-weight:bold;margin:10px 0 3px">DESTINATÁRIO / REMETENTE</div>
    <table style="width:100%;border-collapse:collapse;table-layout:fixed;font-size:13px">
      <tr>
        <td style="width:55%;${cell}"><div style="font-size:11px">NOME / RAZÃO SOCIAL</div><b>${destinatario}</b></td>
        <td style="${cell}"><div style="font-size:11px">CNPJ / CPF</div><b>98.765.432/0001-10</b></td>
        <td style="${cell}"><div style="font-size:11px">DATA DA EMISSÃO</div><b>${emissao}</b></td>
      </tr>
      <tr>
        <td style="${cell}"><div style="font-size:11px">ENDEREÇO</div><b>${endereco.split(" - ")[0]}</b></td>
        <td style="${cell}"><div style="font-size:11px">BAIRRO / DISTRITO</div><b>JD. PROF. TARCÍLIA</b></td>
        <td style="${cell}"><div style="font-size:11px">DATA DA SAÍDA</div><b>26/09/2026</b></td>
      </tr>
    </table>
  </div>`;
}

/**
 * The receipt stub. `date`/`signature`/`signer` switch the three things the
 * proof criteria look for; `fullDanfe` keeps the stub attached to the DANFE,
 * which is how many drivers photograph it.
 */
function receiptStub(options) {
  const o = { ...RECEIPT_DEFAULTS, ...options };
  const cell = "border:1.6px solid #222";

  return `<div style="width:1320px;background:#fbfaf5;background-image:${noiseUrl(0.08, 0.9)}, linear-gradient(90deg, transparent 63.6%, rgba(0,0,0,.05) 64%, transparent 64.4%);padding:26px 30px 22px;box-shadow:0 22px 44px rgba(0,0,0,.5);font-family:Arial, Helvetica, sans-serif;color:#1b1b1b">
    <table style="width:100%;border-collapse:collapse;table-layout:fixed">
      <tr>
        <td colspan="2" style="${cell};padding:8px 10px;font-size:15px;line-height:1.35;height:64px">RECEBEMOS DE <b>${o.emitente}</b> OS PRODUTOS E/OU SERVIÇOS CONSTANTES DA NOTA FISCAL ELETRÔNICA INDICADA AO LADO. EMISSÃO: ${o.emissao} &nbsp;VALOR TOTAL: ${o.valor} &nbsp;DESTINATÁRIO: ${o.destinatario} - ${o.endereco}</td>
        <td rowspan="2" style="width:250px;${cell};text-align:center;vertical-align:middle">
          <div style="font-size:30px;font-weight:bold">NF-e</div>
          <div style="font-size:24px;font-weight:bold;margin-top:6px">Nº ${o.nf}</div>
          <div style="font-size:21px;font-weight:bold;margin-top:4px">SÉRIE ${o.serie}</div>
        </td>
      </tr>
      <tr>
        <td style="width:280px;${cell};padding:6px 10px;height:132px;vertical-align:top">
          <div style="font-size:12px">DATA DE RECEBIMENTO</div>
          ${o.date ? `<div style="font-family:${o.handFont ?? HAND_FONT};font-size:${o.dateSize ?? 40}px;color:${INK};margin-top:22px;transform:rotate(${o.dateTilt ?? -3}deg)">${o.date}</div>` : ""}
        </td>
        <td style="${cell};padding:6px 10px;vertical-align:top;position:relative">
          <div style="font-size:12px">IDENTIFICAÇÃO E ASSINATURA DO RECEBEDOR</div>
          ${o.signature ? signatureSvg(o.seed) : ""}
          ${o.signer ? `<div style="font-family:${o.handFont ?? HAND_FONT};font-size:25px;color:${INK};position:absolute;right:28px;bottom:10px;transform:rotate(-2deg)">${o.signer}</div>` : ""}
        </td>
      </tr>
    </table>
    <div style="border-top:2px dashed #666;margin:16px -30px 0"></div>
    ${o.fullDanfe ? danfeHeader({ ...o, seed: o.seed }) : ""}
  </div>`;
}

/** A supermarket NFC-e: a real fiscal document, but not a delivery receipt. */
function nfceCoupon(seed) {
  const random = seeded(seed);
  const items = [
    ["7891000100103", "LEITE UHT INTEGRAL 1L", "12 UN", "5,49", "65,88"],
    ["7896005800018", "ARROZ TIPO 1 5KG", "2 UN", "27,90", "55,80"],
    ["7891910000197", "ACUCAR REFINADO 1KG", "6 UN", "4,79", "28,74"],
    ["7896036090245", "CAFE TORRADO MOIDO 500G", "3 UN", "18,99", "56,97"],
    ["7891149103102", "OLEO DE SOJA 900ML", "4 UN", "7,45", "29,80"],
  ];

  let qr = "";
  for (let row = 0; row < 29; row++) {
    for (let col = 0; col < 29; col++) {
      const finder =
        (row < 7 && col < 7) || (row < 7 && col > 21) || (row > 21 && col < 7);
      const on = finder
        ? row % 6 === 0 || col % 6 === 0 || (row % 22 > 1 && row % 22 < 5 && col % 22 > 1 && col % 22 < 5)
        : random() > 0.5;
      if (on) qr += `<rect x="${col * 8}" y="${row * 8}" width="8" height="8" fill="#111"/>`;
    }
  }

  return `<div style="width:560px;background:#fdfdfb;background-image:${noiseUrl(0.07, 0.9)};padding:30px 28px;font-family:Consolas, 'Courier New', monospace;font-size:17px;color:#222;box-shadow:0 18px 40px rgba(0,0,0,.45);line-height:1.35">
    <div style="text-align:center;font-weight:bold">SUPERMERCADO BOM PRECO LTDA</div>
    <div style="text-align:center">CNPJ 11.222.333/0001-44 IE 123.456.789.000</div>
    <div style="text-align:center">R. XV DE NOVEMBRO, 300 - CENTRO - CAMPINAS SP</div>
    <div style="border-top:1px dashed #444;margin:8px 0"></div>
    <div style="text-align:center;font-weight:bold">DOCUMENTO AUXILIAR DA NOTA FISCAL<br>DE CONSUMIDOR ELETRONICA</div>
    <div style="border-top:1px dashed #444;margin:8px 0"></div>
    ${items.map(([code, name, qty, unit, total]) => `<div>${code} ${name}</div><div style="text-align:right">${qty} x ${unit} = ${total}</div>`).join("")}
    <div style="border-top:1px dashed #444;margin:8px 0"></div>
    <div style="display:flex;justify-content:space-between;font-weight:bold"><span>VALOR TOTAL R$</span><span>237,19</span></div>
    <div style="display:flex;justify-content:space-between"><span>Cartao de Debito</span><span>237,19</span></div>
    <div style="border-top:1px dashed #444;margin:8px 0"></div>
    <div style="text-align:center">NFC-e n. 000812 Serie 003 27/09/2026 10:42:13</div>
    <div style="text-align:center">Consulte pela Chave de Acesso em<br>www.nfce.fazenda.sp.gov.br/consulta</div>
    <div style="text-align:center;font-size:14px">3526 0911 2223 3300 0144 6500 3000 0008 1210 0081 2104</div>
    <div style="text-align:center;margin-top:10px"><svg width="232" height="232">${qr}</svg></div>
    <div style="text-align:center">CONSUMIDOR NAO IDENTIFICADO</div>
  </div>`;
}

/** The package itself, photographed instead of the receipt. */
function cardboardBox(seed) {
  return `<div style="width:1180px;height:860px;position:relative;background:${noiseUrl(0.35, 0.5)}, linear-gradient(160deg,#c89a5e,#a97a42 60%,#8f6534);box-shadow:0 30px 60px rgba(0,0,0,.55);border-radius:6px">
    <div style="position:absolute;left:0;right:0;top:380px;height:110px;background:rgba(210,180,120,.55);background-image:${noiseUrl(0.25, 0.3)};box-shadow:inset 0 0 12px rgba(0,0,0,.2)"></div>
    <div style="position:absolute;left:170px;top:150px;width:820px;background:#fff;padding:26px 32px;font-family:Arial, sans-serif;color:#111;box-shadow:0 4px 10px rgba(0,0,0,.25);transform:rotate(-1.5deg)">
      <div style="font-size:15px">REMETENTE</div>
      <div style="font-size:22px;font-weight:bold">DISTRIBUIDORA ALIANÇA DE ALIMENTOS LTDA</div>
      <div style="border-top:2px solid #111;margin:12px 0"></div>
      <div style="font-size:15px">DESTINATÁRIO</div>
      <div style="font-size:30px;font-weight:bold">MERCADO BOA VISTA LTDA</div>
      <div style="font-size:19px">AV. DAS AMOREIRAS, 1450 - CAMPINAS/SP</div>
      <div style="display:flex;justify-content:space-between;margin-top:14px;font-size:26px;font-weight:bold"><span>NF 45181</span><span>VOLUME 1/3</span><span>18,4 kg</span></div>
      <div style="margin-top:14px">${barcodeSvg(seed, 740, 90)}</div>
    </div>
    <div style="position:absolute;left:60px;bottom:40px;font:bold 48px Arial;color:rgba(40,25,10,.55)">FRÁGIL &nbsp; ↑↑ ESTE LADO PARA CIMA</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Instrument cluster: seven-segment LCD, amber/blue VFD, mechanical drums
// ---------------------------------------------------------------------------

const SEGMENTS = {
  0: "abcdef", 1: "bc", 2: "abged", 3: "abgcd", 4: "fgbc",
  5: "afgcd", 6: "afgedc", 7: "abc", 8: "abcdefg", 9: "abcdfg",
};

function segmentPolygon(name, w, h, t) {
  const half = t / 2;
  const gap = t * 0.18;
  const horizontal = (y) =>
    `${half + gap},${y} ${t + gap},${y - half} ${w - t - gap},${y - half} ${w - half - gap},${y} ${w - t - gap},${y + half} ${t + gap},${y + half}`;
  const vertical = (x, y0, y1) =>
    `${x},${y0 + gap} ${x + half},${y0 + half + gap} ${x + half},${y1 - half - gap} ${x},${y1 - gap} ${x - half},${y1 - half - gap} ${x - half},${y0 + half + gap}`;

  switch (name) {
    case "a": return horizontal(half);
    case "g": return horizontal(h / 2);
    case "d": return horizontal(h - half);
    case "f": return vertical(half, half, h / 2);
    case "b": return vertical(w - half, half, h / 2);
    case "e": return vertical(half, h / 2, h - half);
    default: return vertical(w - half, h / 2, h - half); // c
  }
}

function sevenSegment(text, { x, y, digitWidth, digitHeight, color, ghost, spacing = 1.28 }) {
  let out = "";
  let cursor = x;
  const t = digitWidth * 0.2;

  for (const char of text) {
    if (char === ".") {
      out += `<circle cx="${cursor - digitWidth * 0.12}" cy="${y + digitHeight - t / 2}" r="${t * 0.55}" fill="${color}"/>`;
      continue;
    }
    if (char === " ") {
      cursor += digitWidth * 0.6;
      continue;
    }

    const lit = SEGMENTS[char] || "";
    out += `<g transform="translate(${cursor},${y}) skewX(-7)">`;
    for (const segment of "abcdefg") {
      const on = lit.includes(segment);
      if (!on && !ghost) continue;
      out += `<polygon points="${segmentPolygon(segment, digitWidth, digitHeight, t)}" fill="${on ? color : ghost}"/>`;
    }
    out += "</g>";
    cursor += digitWidth * spacing;
  }

  return out;
}

function dial({ cx, cy, r, max, step, labelEvery, unit, needle = 0, redFrom = null, accent = "#e8e8e8" }) {
  const start = 225;
  const sweep = 270;
  let ticks = "";

  for (let value = 0; value <= max; value += step) {
    const angle = ((start - (value / max) * sweep) * Math.PI) / 180;
    const major = value % labelEvery === 0;
    const inner = r * (major ? 0.8 : 0.87);
    const color = redFrom !== null && value >= redFrom ? "#e0332c" : accent;
    ticks += `<line x1="${cx + inner * Math.cos(angle)}" y1="${cy - inner * Math.sin(angle)}" x2="${cx + r * 0.95 * Math.cos(angle)}" y2="${cy - r * 0.95 * Math.sin(angle)}" stroke="${color}" stroke-width="${major ? 5 : 2.5}"/>`;

    if (major) {
      const lr = r * 0.66;
      const label = max <= 10 ? value : value;
      ticks += `<text x="${cx + lr * Math.cos(angle)}" y="${cy - lr * Math.sin(angle) + 12}" fill="${color}" font-family="Arial" font-size="${r * 0.13}" font-weight="bold" text-anchor="middle">${label}</text>`;
    }
  }

  const needleAngle = ((start - (needle / max) * sweep) * Math.PI) / 180;

  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#dialFace)" stroke="#555" stroke-width="6"/>
    ${ticks}
    <text x="${cx}" y="${cy - r * 0.28}" fill="#bbb" font-family="Arial" font-size="${r * 0.09}" text-anchor="middle">${unit}</text>
    <line x1="${cx - r * 0.12 * Math.cos(needleAngle)}" y1="${cy + r * 0.12 * Math.sin(needleAngle)}" x2="${cx + r * 0.82 * Math.cos(needleAngle)}" y2="${cy - r * 0.82 * Math.sin(needleAngle)}" stroke="#ff3b1f" stroke-width="9" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.09}" fill="#222" stroke="#666" stroke-width="3"/>`;
}

const LCD_STYLES = {
  lcd: { panel: "#9fb49b", ink: "#161a16", ghost: "rgba(0,0,0,.07)", label: "#1d241d" },
  amber: { panel: "#0b0906", ink: "#ffae1a", ghost: "rgba(255,174,26,.06)", label: "#ffae1a" },
  blue: { panel: "#05080d", ink: "#9fd4ff", ghost: "rgba(159,212,255,.05)", label: "#9fd4ff" },
};

/**
 * A car/truck cluster with the odometer in a centre display. `tripBig` swaps
 * the sizes so the trip meter is the prominent number — the distractor a
 * model has to see past.
 */
function digitalCluster({ odo, trip = "345.6", style = "lcd", clock = "07:42", tripBig = false, speedMax = 220 }) {
  const s = LCD_STYLES[style];
  const glow = style === "lcd" ? "" : `filter="url(#glow)"`;
  const odoSize = tripBig ? { w: 26, h: 44 } : { w: 38, h: 66 };
  const tripSize = tripBig ? { w: 40, h: 70 } : { w: 22, h: 38 };

  return `<svg width="1500" height="780" viewBox="0 0 1500 780" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="dialFace" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#1c1d20"/><stop offset="1" stop-color="#050506"/></radialGradient>
      <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3c40"/><stop offset="1" stop-color="#101113"/></linearGradient>
      <filter id="glow"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect x="10" y="30" width="1480" height="720" rx="210" fill="url(#bezel)" stroke="#000" stroke-width="10"/>
    ${dial({ cx: 300, cy: 390, r: 255, max: speedMax, step: 10, labelEvery: 20, unit: "km/h" })}
    ${dial({ cx: 1200, cy: 390, r: 255, max: 8, step: 0.5, labelEvery: 1, unit: "x1000 r/min", redFrom: 6.5 })}
    <rect x="575" y="215" width="350" height="360" rx="22" fill="${s.panel}" stroke="#000" stroke-width="6"/>
    <g ${glow}>
      <text x="600" y="262" fill="${s.label}" font-family="Arial" font-size="30" font-weight="bold">${clock}</text>
      <text x="900" y="262" fill="${s.label}" font-family="Arial" font-size="30" font-weight="bold" text-anchor="end">24°C</text>
      <text x="600" y="${tripBig ? 330 : 360}" fill="${s.label}" font-family="Arial" font-size="24" font-weight="bold">TRIP A</text>
      ${sevenSegment(trip, { x: tripBig ? 612 : 720, y: tripBig ? 345 : 330, digitWidth: tripSize.w, digitHeight: tripSize.h, color: s.ink, ghost: s.ghost })}
      <text x="${tripBig ? 880 : 890}" y="${tripBig ? 410 : 368}" fill="${s.label}" font-family="Arial" font-size="22" font-weight="bold">km</text>
      <text x="600" y="${tripBig ? 470 : 432}" fill="${s.label}" font-family="Arial" font-size="24" font-weight="bold">ODO</text>
      ${sevenSegment(odo, { x: tripBig ? 700 : 606, y: tripBig ? 485 : 450, digitWidth: odoSize.w, digitHeight: odoSize.h, color: s.ink, ghost: s.ghost })}
      <text x="890" y="${tripBig ? 525 : 548}" fill="${s.label}" font-family="Arial" font-size="22" font-weight="bold" text-anchor="end">km</text>
    </g>
    <circle cx="660" cy="690" r="16" fill="#3b3b3b"/><circle cx="750" cy="690" r="16" fill="#3b3b3b"/><circle cx="840" cy="690" r="16" fill="#3b3b3b"/>
  </svg>`;
}

/** Mechanical odometer: white digits on rolling black drums. */
function drumCluster({ odo, trip = "0345" , seed = 1 }) {
  const random = seeded(seed);
  const drums = (text, x, y, w, h, lastRed = false) =>
    text
      .split("")
      .map((digit, index) => {
        const offset = (random() - 0.5) * h * 0.12;
        const last = lastRed && index === text.length - 1;
        return `<rect x="${x + index * (w + 4)}" y="${y}" width="${w}" height="${h}" fill="url(#${last ? "drumWhite" : "drum"})"/>
          <text x="${x + index * (w + 4) + w / 2}" y="${y + h * 0.74 + offset}" fill="${last ? "#b3121b" : "#f1f1f1"}" font-family="'Arial Narrow', Arial" font-size="${h * 0.78}" font-weight="bold" text-anchor="middle">${digit}</text>`;
      })
      .join("");

  return `<svg width="1100" height="1000" viewBox="0 0 1100 1000" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="dialFace" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#f4f1e8"/><stop offset="1" stop-color="#d6d1c4"/></radialGradient>
      <linearGradient id="drum" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset=".5" stop-color="#2e2e2e"/><stop offset="1" stop-color="#000"/></linearGradient>
      <linearGradient id="drumWhite" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9a9a9a"/><stop offset=".5" stop-color="#f5f5f5"/><stop offset="1" stop-color="#9a9a9a"/></linearGradient>
    </defs>
    <circle cx="550" cy="500" r="470" fill="#111" stroke="#6d6d6d" stroke-width="14"/>
    ${dial({ cx: 550, cy: 500, r: 440, max: 160, step: 5, labelEvery: 20, unit: "km/h", accent: "#1a1a1a" })}
    <rect x="345" y="600" width="${6 * 58 + 22}" height="96" rx="6" fill="#1b1b1b" stroke="#888" stroke-width="4"/>
    ${drums(odo, 356, 610, 54, 76)}
    <rect x="420" y="720" width="${4 * 40 + 20}" height="64" rx="5" fill="#1b1b1b" stroke="#888" stroke-width="3"/>
    ${drums(trip, 430, 728, 36, 48, true)}
    <text x="620" y="770" fill="#1a1a1a" font-family="Arial" font-size="22" font-weight="bold">TRIP</text>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Fuel gauge
// ---------------------------------------------------------------------------

function pumpIcon(x, y, size, color) {
  return `<g transform="translate(${x},${y}) scale(${size / 40})" fill="${color}">
    <rect x="4" y="4" width="20" height="32" rx="3"/><rect x="8" y="8" width="12" height="9" fill="#000" opacity=".55"/>
    <path d="M24 12 h5 l5 6 v14 a3 3 0 0 1 -6 0 v-9 h-4" fill="none" stroke="${color}" stroke-width="3"/>
  </g>`;
}

function gauge({ cx, cy, r, level, left, right, mid, redLow = false, redHigh = false }) {
  const angleFor = (fraction) => ((150 - fraction * 120) * Math.PI) / 180;
  let ticks = "";

  for (let i = 0; i <= 8; i++) {
    const fraction = i / 8;
    const angle = angleFor(fraction);
    const major = i % 4 === 0;
    const red = (redLow && fraction <= 0.125) || (redHigh && fraction >= 0.875);
    ticks += `<line x1="${cx + r * (major ? 0.72 : 0.8) * Math.cos(angle)}" y1="${cy - r * (major ? 0.72 : 0.8) * Math.sin(angle)}" x2="${cx + r * 0.95 * Math.cos(angle)}" y2="${cy - r * 0.95 * Math.sin(angle)}" stroke="${red ? "#e0332c" : "#eee"}" stroke-width="${major ? 8 : 4}"/>`;
  }

  const labelAt = (fraction, text) => {
    const angle = angleFor(fraction);
    return `<text x="${cx + r * 0.52 * Math.cos(angle)}" y="${cy - r * 0.52 * Math.sin(angle) + 14}" fill="#eee" font-family="Arial" font-size="${r * 0.16}" font-weight="bold" text-anchor="middle">${text}</text>`;
  };

  const needle = angleFor(level);

  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#gaugeFace)" stroke="#555" stroke-width="7"/>
    ${ticks}${labelAt(0, left)}${labelAt(1, right)}${mid ? labelAt(0.5, mid) : ""}
    <line x1="${cx}" y1="${cy}" x2="${cx + r * 0.86 * Math.cos(needle)}" y2="${cy - r * 0.86 * Math.sin(needle)}" stroke="#ff4a1c" stroke-width="10" stroke-linecap="round"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.1}" fill="#222" stroke="#777" stroke-width="3"/>`;
}

function fuelCluster({ level, warning }) {
  return `<svg width="1400" height="760" viewBox="0 0 1400 760" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <radialGradient id="gaugeFace" cx="50%" cy="45%" r="60%"><stop offset="0" stop-color="#1d1e21"/><stop offset="1" stop-color="#050506"/></radialGradient>
      <linearGradient id="bezel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a3c40"/><stop offset="1" stop-color="#101113"/></linearGradient>
      <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
    </defs>
    <rect x="10" y="20" width="1380" height="720" rx="180" fill="url(#bezel)" stroke="#000" stroke-width="10"/>
    ${gauge({ cx: 390, cy: 430, r: 280, level: 0.48, left: "C", right: "H", redHigh: true })}
    <text x="390" y="560" fill="#ccc" font-family="Arial" font-size="34" text-anchor="middle">🌡</text>
    ${gauge({ cx: 1010, cy: 430, r: 280, level, left: "E", right: "F", mid: "½", redLow: true })}
    ${pumpIcon(985, 520, 56, "#cfcfcf")}
    <g ${warning ? 'filter="url(#glow)"' : ""}>${pumpIcon(670, 610, 70, warning ? "#ffb300" : "#2b2b2b")}</g>
  </svg>`;
}

// ---------------------------------------------------------------------------
// Tyre tread close-up
// ---------------------------------------------------------------------------

function tyreTread({ worn, seed }) {
  const random = seeded(seed);
  const width = 900;
  const height = 1500;
  const grooveXs = [170, 360, 540, 730];
  const grooveWidth = worn ? 9 : 30;
  const grooveColor = worn ? "#232323" : "#040404";
  let pattern = "";

  for (const x of grooveXs) {
    pattern += `<rect x="${x - grooveWidth / 2}" y="0" width="${grooveWidth}" height="${height}" fill="${grooveColor}"/>`;
    if (!worn) {
      for (let y = 60; y < height; y += 180) {
        pattern += `<rect x="${x - 7}" y="${y}" width="14" height="22" fill="#262626"/>`;
      }
    }
  }

  // Lateral sipes: deep and regular on a new tyre, almost gone on a bald one.
  for (let y = 20; y < height; y += worn ? 150 : 75) {
    for (let lane = 0; lane < 5; lane++) {
      const x0 = [30, 185, 375, 555, 745][lane];
      const x1 = [155, 345, 525, 715, 870][lane];
      if (worn && (lane === 1 || lane === 2 || lane === 3)) continue;
      pattern += `<line x1="${x0}" y1="${y}" x2="${x1}" y2="${y + 38 + random() * 8}" stroke="${worn ? "#2c2c2c" : "#050505"}" stroke-width="${worn ? 3 : 11}"/>`;
    }
  }

  let damage = "";
  if (worn) {
    // A cut through to the steel belt.
    let cords = "";
    for (let i = 0; i < 9; i++) {
      cords += `<line x1="${400 + i * 10}" y1="640" x2="${440 + i * 10}" y2="820" stroke="${i % 3 === 0 ? "#8b5a2b" : "#a9a9a9"}" stroke-width="4"/>`;
    }
    damage = `<path d="M390 620 L470 630 L500 700 L470 800 L420 840 L380 760 Z" fill="#141414"/>
      <g clip-path="url(#cut)">${cords}</g>
      <clipPath id="cut"><path d="M395 630 L465 638 L492 700 L465 795 L422 830 L386 758 Z"/></clipPath>
      <ellipse cx="450" cy="300" rx="240" ry="120" fill="rgba(255,255,255,.07)"/>`;
  }

  return `<div style="position:relative;width:${width + 240}px;height:${height}px">
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" style="position:absolute;left:120px;top:0;border-radius:60px">
      <defs><linearGradient id="treadShade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#151515"/><stop offset=".5" stop-color="${worn ? "#3d3d3d" : "#2a2a2a"}"/><stop offset="1" stop-color="#151515"/></linearGradient></defs>
      <rect width="${width}" height="${height}" fill="url(#treadShade)"/>
      <rect width="${width}" height="${height}" fill="url(#treadShade)" opacity=".3"/>
      ${pattern}${damage}
    </svg>
    <div style="position:absolute;left:0;top:0;width:130px;height:${height}px;background:linear-gradient(90deg,#0c0c0c,#1f1f1f);border-radius:60px 0 0 60px"></div>
    <div style="position:absolute;left:-10px;top:520px;transform:rotate(-90deg);transform-origin:left top;font:bold 46px Arial;color:#3a3a3a;letter-spacing:4px;white-space:nowrap">185/65 R15 88H &nbsp; TWI ▲</div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Windshield (default checklist prompt) and fire extinguisher
// ---------------------------------------------------------------------------

function crackedWindshield(seed) {
  const random = seeded(seed);
  const cx = 980;
  const cy = 430;
  let cracks = "";

  for (let i = 0; i < 11; i++) {
    let angle = (i / 11) * Math.PI * 2 + random() * 0.3;
    let x = cx;
    let y = cy;
    let d = `M ${cx} ${cy}`;
    const length = 180 + random() * 520;
    for (let travelled = 0; travelled < length; travelled += 30) {
      angle += (random() - 0.5) * 0.35;
      x += Math.cos(angle) * 30;
      y += Math.sin(angle) * 30;
      d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    cracks += `<path d="${d}" fill="none" stroke="rgba(255,255,255,.85)" stroke-width="${1.5 + random() * 1.5}"/>`;
  }
  for (let ring = 1; ring <= 3; ring++) {
    cracks += `<circle cx="${cx}" cy="${cy}" r="${ring * 34}" fill="none" stroke="rgba(255,255,255,.6)" stroke-width="1.5" stroke-dasharray="${20 + ring * 10} ${14 + ring * 6}"/>`;
  }

  return `<svg width="1600" height="1200" viewBox="0 0 1600 1200" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fb7de"/><stop offset=".55" stop-color="#e3edf5"/><stop offset=".56" stop-color="#7b7f7a"/><stop offset="1" stop-color="#555"/></linearGradient>
    </defs>
    <rect width="1600" height="1200" fill="url(#sky)"/>
    <path d="M620 640 L980 640 L1500 1200 L100 1200 Z" fill="#4a4a4a"/>
    <path d="M795 660 L805 660 L840 760 L820 760 Z M830 800 L850 800 L900 960 L870 960 Z" fill="#e8e8d0"/>
    <ellipse cx="220" cy="600" rx="260" ry="120" fill="#4f6b3a"/><ellipse cx="1400" cy="610" rx="300" ry="110" fill="#56713f"/>
    <path d="M0 0 L180 0 L90 1200 L0 1200 Z M1600 0 L1420 0 L1510 1200 L1600 1200 Z" fill="#141414"/>
    <path d="M0 950 Q800 860 1600 950 L1600 1200 L0 1200 Z" fill="#1c1c1e"/>
    <rect x="700" y="0" width="200" height="120" rx="14" fill="#1a1a1a"/>
    ${cracks}
    <circle cx="${cx}" cy="${cy}" r="10" fill="rgba(255,255,255,.9)"/>
  </svg>`;
}

function fireExtinguisher() {
  return `<svg width="900" height="1400" viewBox="0 0 900 1400" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="red" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7d0c0c"/><stop offset=".35" stop-color="#e02222"/><stop offset=".55" stop-color="#ff5a4d"/><stop offset="1" stop-color="#6d0909"/></linearGradient>
    </defs>
    <rect x="270" y="330" width="360" height="1000" rx="120" fill="url(#red)"/>
    <rect x="370" y="210" width="160" height="140" rx="20" fill="#222"/>
    <path d="M530 250 L720 180 L730 210 L540 285 Z" fill="#303030"/>
    <path d="M370 280 Q220 360 250 700" fill="none" stroke="#111" stroke-width="26"/>
    <circle cx="450" cy="160" r="95" fill="#f4f4f4" stroke="#999" stroke-width="10"/>
    <path d="M385 185 A70 70 0 0 1 395 105" fill="none" stroke="#d62b2b" stroke-width="16"/>
    <path d="M405 97 A70 70 0 0 1 495 97" fill="none" stroke="#1faa3a" stroke-width="16"/>
    <path d="M505 105 A70 70 0 0 1 515 185" fill="none" stroke="#d62b2b" stroke-width="16"/>
    <line x1="450" y1="170" x2="462" y2="98" stroke="#111" stroke-width="7"/>
    <text x="450" y="228" font-family="Arial" font-size="20" text-anchor="middle" fill="#333">kgf/cm²</text>
    <rect x="300" y="560" width="300" height="470" fill="#fbfbf6"/>
    <text x="450" y="610" font-family="Arial" font-size="30" font-weight="bold" text-anchor="middle">EXTINTOR DE</text>
    <text x="450" y="648" font-family="Arial" font-size="30" font-weight="bold" text-anchor="middle">INCÊNDIO</text>
    <text x="450" y="700" font-family="Arial" font-size="40" font-weight="bold" text-anchor="middle" fill="#c21010">PÓ ABC</text>
    <text x="450" y="745" font-family="Arial" font-size="24" text-anchor="middle">CAPACIDADE: 1 kg</text>
    <text x="450" y="790" font-family="Arial" font-size="22" text-anchor="middle">CLASSES A · B · C</text>
    <text x="450" y="850" font-family="Arial" font-size="23" font-weight="bold" text-anchor="middle">VALIDADE DA CARGA</text>
    <text x="450" y="890" font-family="Arial" font-size="34" font-weight="bold" text-anchor="middle">08/2027</text>
    <circle cx="450" cy="965" r="45" fill="none" stroke="#1d4fa0" stroke-width="5"/>
    <text x="450" y="975" font-family="Arial" font-size="18" font-weight="bold" text-anchor="middle" fill="#1d4fa0">INMETRO</text>
  </svg>`;
}

/**
 * A photo of a screen: the odometer shown in a gallery app on another phone.
 * Moiré, sub-pixel stripes, a glare band and the gallery chrome are what give
 * a re-photographed screen away — "foto de tela" in the product's own prompt.
 */
function phoneShowingCluster(clusterSvg) {
  return `<div style="width:900px;height:1480px;border-radius:70px;background:#0b0b0c;padding:34px;box-shadow:0 30px 60px rgba(0,0,0,.6);position:relative">
    <div style="position:relative;width:100%;height:100%;border-radius:40px;overflow:hidden;background:#000">
      <div style="height:64px;display:flex;justify-content:space-between;align-items:center;padding:0 34px;color:#eee;font:28px Arial"><span>14:32</span><span>▲ ◢ 87%</span></div>
      <div style="height:80px;display:flex;align-items:center;gap:26px;padding:0 30px;color:#eee;font:30px Arial"><span>‹</span><span>IMG_20260912_074211.jpg</span></div>
      <div style="position:absolute;top:420px;left:0;width:100%;transform:scale(.555);transform-origin:left top">${clusterSvg}</div>
      <div style="position:absolute;bottom:0;left:0;right:0;height:120px;display:flex;justify-content:space-around;align-items:center;color:#ddd;font:26px Arial"><span>Compartilhar</span><span>Editar</span><span>Excluir</span></div>
      <div style="position:absolute;inset:0;background:repeating-linear-gradient(90deg, rgba(255,0,0,.07) 0 1px, rgba(0,255,0,.07) 1px 2px, rgba(0,0,255,.07) 2px 3px)"></div>
      <div style="position:absolute;inset:0;background:repeating-linear-gradient(11deg, rgba(255,255,255,.07) 0 2px, transparent 2px 5px), repeating-linear-gradient(-8deg, rgba(0,0,0,.12) 0 2px, transparent 2px 6px)"></div>
      <div style="position:absolute;inset:0;background:linear-gradient(118deg, transparent 38%, rgba(255,255,255,.22) 46%, transparent 55%)"></div>
    </div>
  </div>`;
}

export {
  BACKGROUNDS,
  cardboardBox,
  crackedWindshield,
  digitalCluster,
  drumCluster,
  fireExtinguisher,
  fuelCluster,
  nfceCoupon,
  noiseUrl,
  phoneShowingCluster,
  receiptStub,
  scene,
  seeded,
  tyreTread,
};
