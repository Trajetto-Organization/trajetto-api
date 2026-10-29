#!/usr/bin/env node
/**
 * The address ranges this repository writes down, against the ones their
 * owners publish today (network-ranges.yml, every Monday). Read-only.
 *
 * - Cloudflare's edge (https://www.cloudflare.com/ips-v4 and /ips-v6) against
 *   src/config/trusted-edge.ts. The IPv4 half is also the origin firewall's
 *   allowlist (Contabo, ports 80 and 443, docs/deploy.md section 6): a range
 *   Cloudflare adds and the firewall lacks answers 522 to the users that edge
 *   serves.
 * - GitHub's IPv6 (https://api.github.com/meta: `web`, `api`, `git`) against
 *   infra/scripts/github-ipv4-egress.sh: a range GitHub adds puts image pulls
 *   back on the VPS's IPv6 path, which resets them.
 *
 * A difference fails the run with what to add or remove and where, so GitHub
 * e-mails the schedule's owner weeks before the change bites. A source that
 * cannot be read after three tries fails too: a silent green would mean
 * nothing was checked.
 *
 * Env, for the tests: CLOUDFLARE_IPS_BASE (default https://www.cloudflare.com),
 * GITHUB_META_URL (default https://api.github.com/meta).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CLOUDFLARE =
  process.env.CLOUDFLARE_IPS_BASE ?? "https://www.cloudflare.com";
const GITHUB_META =
  process.env.GITHUB_META_URL ?? "https://api.github.com/meta";
const GITHUB_KEYS = ["web", "api", "git"];

const EDGE_FILE = "src/config/trusted-edge.ts";
const EGRESS_FILE = "infra/scripts/github-ipv4-egress.sh";

let failed = false;
const summary = [];

function error(message) {
  failed = true;
  console.log(`::error::${message}`);
  summary.push(`- ❌ ${message}`);
}

function ok(message) {
  console.log(message);
  summary.push(`- ✅ ${message}`);
}

/** The CIDRs of the CLOUDFLARE_EDGE_CIDRS array, as written. */
function edgeRanges() {
  const source = readFileSync(`${ROOT}${EDGE_FILE}`, "utf8");
  const block = source.match(/CLOUDFLARE_EDGE_CIDRS[^=]*=\s*\[([\s\S]*?)\];/);

  if (!block)
    throw new Error(`CLOUDFLARE_EDGE_CIDRS não encontrado em ${EDGE_FILE}`);

  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
}

/** The PREFIXES line of the egress script. */
function egressRanges() {
  const source = readFileSync(`${ROOT}${EGRESS_FILE}`, "utf8");
  const line = source.match(/^PREFIXES="([^"]*)"/m);

  if (!line) throw new Error(`PREFIXES não encontrado em ${EGRESS_FILE}`);

  return line[1].split(/\s+/).filter(Boolean);
}

async function fetchText(url) {
  let last = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { "user-agent": "trajetto-network-ranges" },
        signal: AbortSignal.timeout(20_000),
      });

      if (response.ok) return await response.text();

      last = `HTTP ${response.status}`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }

    if (attempt < 3)
      await new Promise((done) => setTimeout(done, 2_000 * attempt));
  }

  throw new Error(`${url}: ${last}`);
}

const cidrLines = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line.includes("/"));

/** What `published` has that `written` lacks, and the reverse. */
function diff(published, written) {
  const have = new Set(written.map((cidr) => cidr.toLowerCase()));
  const want = new Set(published.map((cidr) => cidr.toLowerCase()));

  return {
    missing: [...want].filter((cidr) => !have.has(cidr)),
    stale: [...have].filter((cidr) => !want.has(cidr)),
  };
}

async function checkCloudflare() {
  let published;

  try {
    const [v4, v6] = await Promise.all([
      fetchText(`${CLOUDFLARE}/ips-v4`),
      fetchText(`${CLOUDFLARE}/ips-v6`),
    ]);
    published = { v4: cidrLines(v4), v6: cidrLines(v6) };
  } catch (cause) {
    error(
      `Cloudflare: não foi possível ler as faixas publicadas (${cause.message}).`,
    );
    return;
  }

  if (!published.v4.length || !published.v6.length) {
    error("Cloudflare: a lista publicada veio vazia; nada foi conferido.");
    return;
  }

  const written = edgeRanges();
  const { missing, stale } = diff([...published.v4, ...published.v6], written);

  if (!missing.length && !stale.length) {
    ok(
      `Cloudflare: as ${written.length} faixas de ${EDGE_FILE} são as publicadas (${published.v4.length} IPv4, ${published.v6.length} IPv6).`,
    );
    return;
  }

  const v4Missing = missing.filter((cidr) => !cidr.includes(":"));

  if (missing.length) {
    error(
      `Cloudflare publicou faixas que faltam em ${EDGE_FILE}: ${missing.join(", ")}.` +
        (v4Missing.length
          ? ` As IPv4 (${v4Missing.join(", ")}) também entram nas regras 80 e 443 do firewall da Contabo (docs/deploy.md, seção 6), senão essa borda responde 522.`
          : ""),
    );
  }

  if (stale.length) {
    error(
      `Cloudflare não publica mais: ${stale.join(", ")}. Tire de ${EDGE_FILE} e, as IPv4, do firewall da Contabo.`,
    );
  }
}

async function checkGithub() {
  let published;

  try {
    const meta = JSON.parse(await fetchText(GITHUB_META));
    published = [
      ...new Set(
        GITHUB_KEYS.flatMap((key) => meta[key] ?? []).filter((cidr) =>
          cidr.includes(":"),
        ),
      ),
    ];
  } catch (cause) {
    error(`GitHub: não foi possível ler ${GITHUB_META} (${cause.message}).`);
    return;
  }

  if (!published.length) {
    error(
      "GitHub: api.github.com/meta não trouxe faixas IPv6 em web/api/git; nada foi conferido.",
    );
    return;
  }

  const written = egressRanges();
  const { missing, stale } = diff(published, written);

  if (!missing.length && !stale.length) {
    ok(
      `GitHub: as faixas IPv6 de ${EGRESS_FILE} são as publicadas (${written.join(", ")}).`,
    );
    return;
  }

  if (missing.length) {
    error(
      `GitHub publicou faixas IPv6 que faltam em ${EGRESS_FILE}: ${missing.join(", ")}. Acrescente em PREFIXES e rode \`install\` de novo no servidor, senão os pulls do GHCR voltam ao IPv6.`,
    );
  }

  if (stale.length) {
    error(
      `GitHub não publica mais: ${stale.join(", ")}. Tire de PREFIXES em ${EGRESS_FILE}.`,
    );
  }
}

await checkCloudflare();
await checkGithub();

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Faixas de rede\n\n${summary.join("\n")}\n`,
  );
}

process.exit(failed ? 1 : 0);
