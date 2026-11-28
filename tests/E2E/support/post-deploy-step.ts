import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { openReleaseClient } from "infra/scripts/release-connection";
import {
  listReleaseSteps,
  runReleaseSteps,
} from "infra/scripts/release-step-runner";

/**
 * One file of prisma/post-deploy run on this E2E file's database by the
 * release step's own runner (plano-escala F5-08), as the release does it:
 * its session, its lock_timeout, its NOTICE read as the step's state.
 * `settings` are the session settings the release step would hand every
 * file (the approved interval of the history window, F2-17). Returns that
 * state.
 */
async function runPostDeployStep(
  name: string,
  applicationName = "e2e-post-deploy",
  settings: Readonly<Record<string, string>> = {},
): Promise<{ status: string; detail: string }> {
  const root = mkdtempSync(join(tmpdir(), "trajetto-post-deploy-"));

  mkdirSync(join(root, "prisma", "post-deploy"), { recursive: true });
  copyFileSync(
    resolve(process.cwd(), "prisma", "post-deploy", name),
    join(root, "prisma", "post-deploy", name),
  );

  const client = await openReleaseClient(
    process.env.DATABASE_URL as string,
    applicationName,
  );

  try {
    const outcome = await runReleaseSteps(client, listReleaseSteps(root), {
      log: { info: () => undefined, warn: () => undefined },
      postDeploy: true,
      settings,
    });

    const [step] = outcome.steps;

    return { status: step.status, detail: step.detail };
  } finally {
    await client.end();
    rmSync(root, { recursive: true, force: true });
  }
}

export { runPostDeployStep };
