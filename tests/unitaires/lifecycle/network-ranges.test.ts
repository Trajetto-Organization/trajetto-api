import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLOUDFLARE_EDGE_CIDRS } from "@/config/trusted-edge";

/**
 * The weekly check of the address ranges this repository writes down
 * (.github/workflows/network-ranges.yml).
 *
 * Two lists here follow someone else's: Cloudflare's edge
 * (src/config/trusted-edge.ts, whose IPv4 half is also the origin firewall's
 * allowlist for ports 80 and 443) and GitHub's IPv6
 * (infra/scripts/github-ipv4-egress.sh, which keeps image pulls on IPv4). A
 * range added upstream and missing here turns into 522s for one Cloudflare
 * edge, or into pulls back on the IPv6 path that resets them. The check runs
 * for real, against a fake Cloudflare and a fake GitHub on the loopback.
 */
const ROOT = process.cwd();
const SCRIPT = resolve(ROOT, ".github", "scripts", "check-network-ranges.mjs");
const EGRESS = readFileSync(
  resolve(ROOT, "infra", "scripts", "github-ipv4-egress.sh"),
  "utf8",
);
const GITHUB_V6 = (EGRESS.match(/^PREFIXES="([^"]*)"/m)?.[1] ?? "")
  .split(/\s+/)
  .filter(Boolean);

const V4 = CLOUDFLARE_EDGE_CIDRS.filter((cidr) => !cidr.includes(":"));
const V6 = CLOUDFLARE_EDGE_CIDRS.filter((cidr) => cidr.includes(":"));

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

interface Upstream {
  v4?: string[];
  v6?: string[];
  github?: string[];
  status?: number;
}

async function upstream(options: Upstream): Promise<string> {
  server = createServer((request, response) => {
    if (options.status) {
      response.writeHead(options.status).end();
      return;
    }

    if (request.url === "/ips-v4") {
      response.end(`${(options.v4 ?? V4).join("\n")}\n`);
    } else if (request.url === "/ips-v6") {
      response.end(`${(options.v6 ?? V6).join("\n")}\n`);
    } else if (request.url === "/meta") {
      const github = options.github ?? GITHUB_V6;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          web: ["192.30.252.0/22", ...github],
          api: ["192.30.252.0/22", ...github],
          git: github,
          packages: ["140.82.112.0/20"],
        }),
      );
    } else {
      response.writeHead(404).end();
    }
  });

  await new Promise<void>((done) => server!.listen(0, "127.0.0.1", done));

  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

function check(base: string): Promise<{ code: number | null; out: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: ROOT,
      env: {
        ...process.env,
        CLOUDFLARE_IPS_BASE: base,
        GITHUB_META_URL: `${base}/meta`,
        GITHUB_STEP_SUMMARY: "",
      },
    });
    let out = "";

    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
}

describe("network-ranges check", () => {
  it("passes when both lists are the published ones", async () => {
    const { code, out } = await check(await upstream({}));

    expect(code, out).toBe(0);
    expect(out).toContain(
      `as ${CLOUDFLARE_EDGE_CIDRS.length} faixas de src/config/trusted-edge.ts são as publicadas`,
    );
    expect(out).toContain(
      "as faixas IPv6 de infra/scripts/github-ipv4-egress.sh são as publicadas",
    );
  });

  it("fails when Cloudflare adds an IPv4 range, and says it also goes into the firewall", async () => {
    const { code, out } = await check(
      await upstream({ v4: [...V4, "198.51.100.0/24"] }),
    );

    expect(code).toBe(1);
    expect(out).toContain("::error::Cloudflare publicou faixas que faltam");
    expect(out).toContain("198.51.100.0/24");
    expect(out).toContain("firewall da Contabo");
  });

  it("fails when Cloudflare drops a range the repository still trusts", async () => {
    const { code, out } = await check(
      await upstream({ v4: V4.filter((cidr) => cidr !== "131.0.72.0/22") }),
    );

    expect(code).toBe(1);
    expect(out).toContain("Cloudflare não publica mais: 131.0.72.0/22");
  });

  it("fails when GitHub adds an IPv6 range the pulls would take", async () => {
    const { code, out } = await check(
      await upstream({ github: [...GITHUB_V6, "2001:db8::/32"] }),
    );

    expect(code).toBe(1);
    expect(out).toContain("GitHub publicou faixas IPv6 que faltam");
    expect(out).toContain("2001:db8::/32");
    expect(out).toContain("rode `install` de novo");
  });

  it("fails, not passes, when a source cannot be read", async () => {
    const { code, out } = await check(await upstream({ status: 503 }));

    expect(code).toBe(1);
    expect(out).toContain("Cloudflare: não foi possível ler");
    expect(out).toContain("GitHub: não foi possível ler");
  }, 30_000);
});

describe("the ranges written down", () => {
  it("keep GitHub's two IPv6 blocks in the egress script", () => {
    expect(GITHUB_V6).toEqual(["2606:50c0::/32", "2a0a:a440::/29"]);
  });

  it("list every Cloudflare IPv4 range in the firewall section of docs/deploy.md", () => {
    const deploy = readFileSync(resolve(ROOT, "docs", "deploy.md"), "utf8");
    const firewall = deploy.slice(deploy.indexOf("### 6.1 Firewall da VPS"));

    for (const cidr of V4) expect(firewall, cidr).toContain(cidr);
  });
});
