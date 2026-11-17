import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";

import {
  loadConcurrentFiles,
  prebuildSettings,
  PrebuildError,
  runPrebuild,
} from "./online-ddl";
import { bouncerRefusal, openReleaseClient } from "./release-connection";

/**
 * The release step's first step: prisma/concurrent, before `prisma migrate
 * deploy` (online-ddl.ts says what and why).
 *
 *   node build/prebuild-online-ddl.js <directory of the .sql files>
 *
 * docker-entrypoint.sh runs it in the `migrate` and `release` modes, with
 * the schema URL in DATABASE_URL; `yarn dev` runs it through tsx. Exit 0
 * when done (or skipped), 1 when an index it manages is left invalid or a
 * file breaks the whitelist (nothing runs then), 64 for a URL through
 * PgBouncer or a missing directory argument.
 *
 * PREBUILD_ONLINE_DDL=off skips it, for an emergency only: the migrations
 * then build their indexes with a plain CREATE INDEX, holding the writes on
 * a hot table for the whole build.
 */
dotenvExpand.expand(dotenv.config());

const PREFIX = "[prebuild]";

async function main(): Promise<number> {
  const directory = process.argv[2];

  if (!directory) {
    console.error(
      `${PREFIX} uso: prebuild-online-ddl <diretório prisma/concurrent>`,
    );

    return 64;
  }

  const url = process.env.DATABASE_URL;
  const refusal = bouncerRefusal(url);

  if (refusal) {
    console.error(`${PREFIX} ERRO: ${refusal}`);

    return 64;
  }

  const settings = prebuildSettings(process.env);

  for (const warning of settings.warnings) console.warn(`${PREFIX} ${warning}`);

  if (!settings.enabled) {
    console.warn(
      `${PREFIX} PREBUILD_ONLINE_DDL=off: prisma/concurrent pulado. As migrations criam os índices sem CONCURRENTLY; tire a variável depois da emergência.`,
    );

    return 0;
  }

  const { files, errors } = loadConcurrentFiles(directory);

  if (errors.length > 0) {
    for (const error of errors) console.error(`${PREFIX} ERRO: ${error}`);
    console.error(`${PREFIX} nada foi executado.`);

    return 1;
  }

  if (files.length === 0) {
    console.log(`${PREFIX} prisma/concurrent sem arquivos: nada a fazer.`);

    return 0;
  }

  const client = await openReleaseClient(url as string, "trajetto-prebuild");

  try {
    const outcome = await runPrebuild(client, files, {
      lockTimeoutMs: settings.lockTimeoutMs,
      lockRetries: settings.lockRetries,
      log: {
        info: (message) => console.log(`${PREFIX} ${message}`),
        warn: (message) => console.warn(`${PREFIX} ${message}`),
      },
    });

    if (!outcome.newDatabase) {
      const applied = outcome.files.filter((file) => file.status === "applied");

      console.log(
        `${PREFIX} concluído: ${applied.length} de ${outcome.files.length} arquivos aplicados, ${outcome.retries} esperas de lock repetidas.`,
      );
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error(
      `${PREFIX} ERRO: ${message}${error instanceof PrebuildError ? "" : " (o comando acima falhou; nada depois dele rodou)"}`,
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
