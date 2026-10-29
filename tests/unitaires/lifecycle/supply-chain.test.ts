import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The supply chain has controls (INFRA-16).
 *
 * There was no Dependabot, no audit gate, no image scan, and every action ran
 * from a movable tag — one of them handed the GITHUB_TOKEN with
 * `packages: write` to whatever the tag pointed at that day. Now:
 * - Dependabot keeps npm, the actions and the base images moving;
 * - every action is pinned by commit SHA and every base image by digest;
 * - audit-ci fails CI on a CRITICAL advisory in a production dependency,
 *   with a reasoned, dated allowlist;
 * - the pushed image gets an SBOM and provenance, and a Trivy scan by digest.
 */
const ROOT = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

const workflows = readdirSync(resolve(ROOT, ".github/workflows"))
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => ({ name, text: read(`.github/workflows/${name}`) }));

describe("Dependabot", () => {
  it("updates npm, the actions and the Docker base images", () => {
    expect(existsSync(resolve(ROOT, ".github/dependabot.yml"))).toBe(true);

    const config = read(".github/dependabot.yml");

    expect(config).toMatch(/package-ecosystem: npm/);
    expect(config).toMatch(/package-ecosystem: github-actions/);
    expect(config).toMatch(/package-ecosystem: docker/);
    expect(config).toMatch(/"\/infra\/ai-ocr"/);
  });
});

describe("the workflows", () => {
  it("pin every action to a full commit SHA, with the version it was", () => {
    const loose = workflows.flatMap(({ name, text }) =>
      text
        .split(/\r?\n/)
        .filter((line) => /^\s*(?:-\s*)?uses:/.test(line))
        .filter(
          (line) =>
            !/uses:\s*[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v?\d+\.\d+\.\d+\s*$/.test(
              line,
            ),
        )
        .map((line) => `${name}: ${line.trim()}`),
    );

    expect(loose).toEqual([]);
  });

  it("fail on a critical advisory in a production dependency, in the branch CI and before a deploy", () => {
    for (const name of ["ci.yml", "deploy.yml"]) {
      expect(read(`.github/workflows/${name}`), name).toMatch(
        /npx --yes audit-ci@\d+\.\d+\.\d+ --config audit-ci\.jsonc/,
      );
    }
  });

  it("publish the images with an SBOM and provenance", () => {
    const deploy = read(".github/workflows/deploy.yml");
    const builds = deploy
      .split("uses: docker/build-push-action@")
      .slice(1)
      .map((build) => build.slice(0, build.search(/\n\s*- name:|\n {2}\w/)));
    const pushed = builds.filter((step) => /push: true/.test(step));

    expect(pushed.length).toBeGreaterThan(0);

    for (const step of pushed) {
      expect(step).toMatch(/sbom: true/);
      expect(step).toMatch(/provenance: mode=(?:max|min)/);
    }

    // Any other build is a smoke test's: loaded into the runner, never
    // published, so it carries no attestations (the classic image store
    // cannot load them).
    for (const step of builds.filter((build) => !pushed.includes(build))) {
      expect(step).toMatch(/push: false/);
      expect(step).toMatch(/load: true/);
    }
  });

  it("scan the pushed image by digest with Trivy pinned by digest", () => {
    const deploy = read(".github/workflows/deploy.yml");

    expect(deploy).toMatch(/aquasec\/trivy:[\d.]+@sha256:[0-9a-f]{64}/);
    expect(deploy).toMatch(
      /trajetto-api@\$\{\{ steps\.build\.outputs\.digest \}\}/,
    );
    expect(deploy).toMatch(/--severity CRITICAL --ignore-unfixed/);
  });
});

describe("audit-ci.jsonc", () => {
  function auditConfig() {
    const text = read("audit-ci.jsonc");

    return { text, config: JSON.parse(text.replace(/^\s*\/\/.*$/gm, "")) };
  }

  it("gates production dependencies on critical advisories", () => {
    const { config } = auditConfig();

    expect(config.critical).toBe(true);
    expect(config["skip-dev"]).toBe(true);
  });

  it("allowlists only advisories, each with a review date", () => {
    const { text, config } = auditConfig();

    for (const id of config.allowlist ?? []) {
      expect(id).toMatch(/^GHSA(?:-[23456789cfghjmpqrvwx]{4}){3}$/);

      // Its own comment: from the end of the previous entry (or the list's
      // opening bracket) up to the id.
      const before = text.slice(0, text.indexOf(`"${id}"`));
      const comment = before.slice(
        Math.max(before.lastIndexOf('",'), before.lastIndexOf("[")),
      );

      expect(comment, id).toMatch(/Revisar até \d{4}-\d{2}-\d{2}/);
    }
  });
});

/**
 * The FROM lines that pull an image. `FROM base AS runner` builds on a stage
 * of the same file; `FROM alpine AS tools` is an image, even with no tag.
 */
function baseImages(dockerfile: string): string[] {
  const stages = new Set<string>();
  const bases: string[] = [];

  for (const line of dockerfile.split(/\r?\n/)) {
    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;

    if (!stages.has(from[1].toLowerCase())) bases.push(line);
    if (from[2]) stages.add(from[2].toLowerCase());
  }

  return bases;
}

describe("the images", () => {
  it("tell an image from a stage of the same file", () => {
    expect(
      baseImages(
        "FROM alpine AS tools\nFROM node:22@sha256:ab AS base\nFROM base AS runner\nFROM tools",
      ),
    ).toEqual(["FROM alpine AS tools", "FROM node:22@sha256:ab AS base"]);
  });

  it.each(["Dockerfile", "infra/ai-ocr/Dockerfile"])(
    "%s pins every base image by digest",
    (path) => {
      const bases = baseImages(read(path));

      expect(bases.length).toBeGreaterThan(0);

      for (const line of bases) expect(line).toMatch(/@sha256:[0-9a-f]{64}/);
    },
  );

  it("ships without npm-run-all: the entrypoint runs node directly", () => {
    const pkg = JSON.parse(read("package.json"));

    expect(pkg.dependencies["npm-run-all"]).toBeUndefined();
    expect(pkg.devDependencies["npm-run-all"]).toBeDefined();
  });
});
