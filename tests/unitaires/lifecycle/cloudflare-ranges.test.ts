import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CLOUDFLARE_EDGE_CIDRS } from "@/config/trusted-edge";

/**
 * The weekly check of Cloudflare's edge (.github/workflows/cloudflare-ranges.yml).
 *
 * src/config/trusted-edge.ts follows Cloudflare's published list, and its
 * IPv4 half is also the origin firewall's allowlist for ports 80 and 443
 * (docs/deploy.md, section 6.1). A range Cloudflare adds and the repository
 * lacks turns into 522s for the users of that edge. The check runs for real,
 * against a fake Cloudflare on the loopback.
 */
const ROOT = process.cwd();
const SCRIPT = resolve(
  ROOT,
  ".github",
  "scripts",
  "check-cloudflare-ranges.mjs",
);

const V4 = CLOUDFLARE_EDGE_CIDRS.filter((cidr) => !cidr.includes(":"));
const V6 = CLOUDFLARE_EDGE_CIDRS.filter((cidr) => cidr.includes(":"));

let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((done) =>
    server ? server.close(() => done()) : done(),
  );
  server = undefined;
});

async function cloudflare(
  options: { v4?: string[]; v6?: string[]; status?: number } = {},
): Promise<string> {
  server = createServer((request, response) => {
    if (options.status) {
      response.writeHead(options.status).end();
    } else if (request.url === "/ips-v4") {
      response.end(`${(options.v4 ?? V4).join("\n")}\n`);
    } else if (request.url === "/ips-v6") {
      response.end(`${(options.v6 ?? V6).join("\n")}\n`);
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
        GITHUB_STEP_SUMMARY: "",
      },
    });
    let out = "";

    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => done({ code, out }));
  });
}

describe("cloudflare-ranges check", () => {
  it("passes when the list is the published one", async () => {
    const { code, out } = await check(await cloudflare());

    expect(code, out).toBe(0);
    expect(out).toContain(
      `As ${CLOUDFLARE_EDGE_CIDRS.length} faixas de src/config/trusted-edge.ts são as publicadas`,
    );
  });

  it("fails when Cloudflare adds an IPv4 range, and says it also goes into the firewall", async () => {
    const { code, out } = await check(
      await cloudflare({ v4: [...V4, "198.51.100.0/24"] }),
    );

    expect(code).toBe(1);
    expect(out).toContain("::error::A Cloudflare publicou faixas que faltam");
    expect(out).toContain("198.51.100.0/24");
    expect(out).toContain("firewall da Contabo");
  });

  it("fails when Cloudflare drops a range the repository still trusts", async () => {
    const { code, out } = await check(
      await cloudflare({ v4: V4.filter((cidr) => cidr !== "131.0.72.0/22") }),
    );

    expect(code).toBe(1);
    expect(out).toContain("A Cloudflare não publica mais: 131.0.72.0/22");
  });

  it("fails, not passes, when the list cannot be read", async () => {
    const { code, out } = await check(await cloudflare({ status: 503 }));

    expect(code).toBe(1);
    expect(out).toContain("Não foi possível ler as faixas da Cloudflare");
  }, 30_000);
});

describe("the firewall section of docs/deploy.md", () => {
  it("lists every Cloudflare IPv4 range the repository trusts", () => {
    const deploy = readFileSync(resolve(ROOT, "docs", "deploy.md"), "utf8");
    const firewall = deploy.slice(deploy.indexOf("### 6.1 Firewall da VPS"));

    for (const cidr of V4) expect(firewall, cidr).toContain(cidr);
  });
});
