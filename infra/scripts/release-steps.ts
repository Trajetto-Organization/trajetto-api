import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";

import { bouncerRefusal, openReleaseClient } from "./release-connection";
import {
  listReleaseSteps,
  postDeployEnabled,
  runReleaseSteps,
  StepFailure,
} from "./release-step-runner";

/**
 * The release step's steps after `prisma migrate deploy`: infra/sql, then
 * prisma/post-deploy, each file's outcome kept in release_step_state
 * (release-step-runner.ts says what and why).
 *
 *   node build/release-steps.js <root holding infra/sql and prisma/post-deploy>
 *
 * docker-entrypoint.sh runs it in the `migrate` and `release` modes, right
 * after the migrations and before the seeds, on the schema URL; `yarn dev`
 * and the E2E template (`yarn release:steps`) run the same. Exit 0 when
 * every step ran (a 'pending' one included: the next deploy runs it
 * again), 1 when one failed, 64 for a URL through PgBouncer or no root.
 *
 * POST_DEPLOY_STEPS=off (the trajetto-api-migrate Application only) skips
 * prisma/post-deploy, for an emergency; infra/sql always runs, because the
 * grants it restores are what lets the runtime read and write.
 */
dotenvExpand.expand(dotenv.config());

const PREFIX = "[release-steps]";

async function main(): Promise<number> {
  const root = process.argv[2];

  if (!root) {
    console.error(
      `${PREFIX} uso: release-steps <diretório com infra/sql e prisma/post-deploy>`,
    );

    return 64;
  }

  const url = process.env.DATABASE_URL;
  const refusal = bouncerRefusal(url);

  if (refusal) {
    console.error(`${PREFIX} ERRO: ${refusal}`);

    return 64;
  }

  const steps = listReleaseSteps(root);
  const client = await openReleaseClient(
    url as string,
    "trajetto-release-steps",
  );

  try {
    await runReleaseSteps(client, steps, {
      postDeploy: postDeployEnabled(process.env),
      log: {
        info: (message) => console.log(`${PREFIX} ${message}`),
        warn: (message) => console.warn(`${PREFIX} ${message}`),
      },
    });

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `${PREFIX} ERRO: ${message}${error instanceof StepFailure ? " Os passos seguintes e os seeds não rodaram." : ""}`,
    );

    return 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(
      `${PREFIX} ERRO: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  },
);
