import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { readAction } from "./support/workflow-text";

/**
 * "Os três repositórios juntos" (docs/deploy.md) is the one section the
 * web's and the app's deploy guides copy byte for byte (their
 * shared-deploy-section.test.ts), so it is where whoever ships any of the
 * three reads the order of a release. Until 18/11/2026 it still said the
 * pipeline deployed "IA → API": the Applications that run the API's image
 * in another role (scale plan F3-31a) went into the deploy action and the
 * API's own chapters only, and a reader of the web or the app never learnt
 * that a worker now goes before the API, and so runs for a while beside
 * the previous API, which is what the compatibility rules are for.
 *
 * This suite holds the section to the deploy the action really runs: the
 * Applications in the order of the action's steps, the roles in the order
 * of .github/scripts/deploy-roles.sh. And it holds the rules that order
 * makes necessary to their names: the contraction that waits in
 * prisma/post-deploy, the app's CLIENT_CONTRACT and MIN_MOBILE_CONTRACT.
 */
const read = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");

const HEADING = /^## (?:\d+\. )?Os três repositórios juntos\n/m;

/** The shared section, from its heading to the next `## `. */
function sharedSection(guide: string): string {
  const start = HEADING.exec(guide);

  if (!start) throw new Error("docs/deploy.md: shared section not found");

  const rest = guide.slice(start.index + start[0].length);
  const end = rest.search(/^## /m);

  return end < 0 ? rest : rest.slice(0, end);
}

/** A `### ` subsection of the shared section, whitespace collapsed. */
function subsection(section: string, title: string): string {
  const at = section.indexOf(`\n### ${title}\n`);

  if (at < 0) throw new Error(`shared section: no "### ${title}"`);

  const rest = section.slice(at + title.length + 6);
  const end = rest.search(/^### /m);

  return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, " ");
}

/** The `roles=(...)` array of deploy-roles.sh. */
function rolesOf(script: string, name: string): string[] {
  const list = new RegExp(`^${name}=\\(([^)]*)\\)$`, "m").exec(script)?.[1];

  if (list === undefined) throw new Error(`deploy-roles.sh: no ${name}`);

  return list.trim().split(/\s+/);
}

/**
 * The Applications the deploy action deploys, in the order of its steps:
 * a step that runs the release or the deploy script names its Application
 * in DOKPLOY_APP_LABEL; a step that runs deploy-roles.sh deploys that
 * phase's roles, each in its own `trajetto-<role>` Application.
 */
function deployOrder(): string[] {
  const script = read(".github/scripts/deploy-roles.sh");
  const phases: Record<string, string[]> = {
    "before-api": rolesOf(script, "BEFORE_API"),
    "after-api": rolesOf(script, "AFTER_API"),
  };

  return readAction("deploy").steps.flatMap((step) => {
    if (/dokploy-(?:release|deploy)\.mjs/.test(step.run)) {
      const label = /\n\s+DOKPLOY_APP_LABEL: (\S+)/.exec(step.text)?.[1];

      return label ? [label] : [];
    }

    const phase = /deploy-roles\.sh (before-api|after-api)\s*$/.exec(
      step.run,
    )?.[1];

    return phase ? phases[phase].map((role) => `trajetto-${role}`) : [];
  });
}

/** Every run of backticked Applications joined by arrows, in order. */
const chainsIn = (text: string) =>
  [...text.matchAll(/`trajetto-[a-z-]+`(?: → `trajetto-[a-z-]+`)+/g)].map(
    ([chain]) => chain.split(" → ").map((name) => name.slice(1, -1)),
  );

describe("the release order the three repositories share", () => {
  const section = sharedSection(read("docs/deploy.md"));
  const release = subsection(section, "Ordem de cada release");
  const order = deployOrder();

  it("reads the deploy from the action and the roles' script", () => {
    expect(order).toEqual([
      "trajetto-api-migrate",
      "trajetto-ai",
      "trajetto-worker",
      "trajetto-scheduler",
      "trajetto-worker-external",
      "trajetto-api",
      "trajetto-ingest",
      "trajetto-realtime",
    ]);
  });

  it("writes the Applications in the order the deploy action runs them", () => {
    expect(chainsIn(release)).toContainEqual(order);
  });

  it("never writes another order of them anywhere in the section", () => {
    const flat = section.replace(/\s+/g, " ");

    for (const chain of chainsIn(flat)) {
      const positions = chain.map((name) => order.indexOf(name));

      expect(positions, chain.join(" → ")).not.toContain(-1);
      expect(positions, chain.join(" → ")).toEqual(
        [...positions].sort((a, b) => a - b),
      );
    }
  });

  it("names the rules the order makes necessary", () => {
    // The roles before the API run beside the previous image: a
    // contraction waits for every process (prisma/post-deploy), and the
    // app moves by contract.
    expect(release).toContain("`prisma/post-deploy`");
    expect(release).toContain("`CLIENT_CONTRACT`");
    expect(release).toContain("`MIN_MOBILE_CONTRACT`");
  });
});
