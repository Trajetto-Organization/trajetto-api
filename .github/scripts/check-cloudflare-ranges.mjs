#!/usr/bin/env node
/**
 * Cloudflare's edge as written in src/config/trusted-edge.ts, against the
 * list Cloudflare publishes today (https://www.cloudflare.com/ips-v4 and
 * /ips-v6). Runs every Monday (cloudflare-ranges.yml). Read-only.
 *
 * The IPv4 half of that list is also the origin firewall's allowlist
 * (Contabo, ports 80 and 443, docs/deploy.md section 6.1): a range Cloudflare
 * adds and the firewall lacks answers 522 to the users that edge serves, and
 * the rate limit stops trusting CF-Connecting-IP from it. A difference fails
 * the run with what to add or remove, so GitHub e-mails the schedule's owner
 * before the change bites. A list that cannot be read after three tries fails
 * too: a silent green would mean nothing was checked.
 *
 * Env, for the tests: CLOUDFLARE_IPS_BASE (default https://www.cloudflare.com).
 */
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASE = process.env.CLOUDFLARE_IPS_BASE ?? "https://www.cloudflare.com";
const EDGE_FILE = "src/config/trusted-edge.ts";

const lines = [];
let failed = false;

function report(ok, message) {
  if (!ok) failed = true;
  console.log(ok ? message : `::error::${message}`);
  lines.push(`- ${ok ? "✅" : "❌"} ${message}`);
}

/** The CIDRs of the CLOUDFLARE_EDGE_CIDRS array, as written. */
function writtenRanges() {
  const source = readFileSync(`${ROOT}${EDGE_FILE}`, "utf8");
  const block = source.match(/CLOUDFLARE_EDGE_CIDRS[^=]*=\s*\[([\s\S]*?)\];/);

  if (!block) {
    throw new Error(`CLOUDFLARE_EDGE_CIDRS não encontrado em ${EDGE_FILE}`);
  }

  return [...block[1].matchAll(/"([^"]+)"/g)].map((match) =>
    match[1].toLowerCase(),
  );
}

async function fetchRanges(path) {
  let last = "";

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${BASE}${path}`, {
        headers: { "user-agent": "trajetto-cloudflare-ranges" },
        signal: AbortSignal.timeout(20_000),
      });

      if (response.ok) {
        return (await response.text())
          .split(/\r?\n/)
          .map((line) => line.trim().toLowerCase())
          .filter((line) => line.includes("/"));
      }

      last = `HTTP ${response.status}`;
    } catch (cause) {
      last = cause instanceof Error ? cause.message : String(cause);
    }

    if (attempt < 3) {
      await new Promise((done) => setTimeout(done, 2_000 * attempt));
    }
  }

  throw new Error(`${BASE}${path}: ${last}`);
}

async function main() {
  let v4;
  let v6;

  try {
    [v4, v6] = await Promise.all([
      fetchRanges("/ips-v4"),
      fetchRanges("/ips-v6"),
    ]);
  } catch (cause) {
    report(
      false,
      `Não foi possível ler as faixas da Cloudflare (${cause.message}).`,
    );
    return;
  }

  if (!v4.length || !v6.length) {
    report(
      false,
      "A lista publicada pela Cloudflare veio vazia; nada foi conferido.",
    );
    return;
  }

  const written = writtenRanges();
  const published = [...v4, ...v6];
  const missing = published.filter((cidr) => !written.includes(cidr));
  const stale = written.filter((cidr) => !published.includes(cidr));

  if (!missing.length && !stale.length) {
    report(
      true,
      `As ${written.length} faixas de ${EDGE_FILE} são as publicadas pela Cloudflare (${v4.length} IPv4, ${v6.length} IPv6).`,
    );
    return;
  }

  if (missing.length) {
    const v4Missing = missing.filter((cidr) => !cidr.includes(":"));

    report(
      false,
      `A Cloudflare publicou faixas que faltam em ${EDGE_FILE}: ${missing.join(", ")}.` +
        (v4Missing.length
          ? ` As IPv4 (${v4Missing.join(", ")}) também entram nas regras 80 e 443 do firewall da Contabo (docs/deploy.md, seção 6.1), senão essa borda responde 522.`
          : ""),
    );
  }

  if (stale.length) {
    report(
      false,
      `A Cloudflare não publica mais: ${stale.join(", ")}. Tire de ${EDGE_FILE} e, as IPv4, do firewall da Contabo.`,
    );
  }
}

await main();

if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Faixas da Cloudflare\n\n${lines.join("\n")}\n`,
  );
}

process.exit(failed ? 1 : 0);
