import database from "@/../infra/database";

import { env } from "@/env";
import { missingArchiveSettings } from "@/shared/archive/archive-settings";
import { archiveStorageFromEnv } from "@/shared/archive/archive-storage";
import {
  ArchiveRestoreError,
  restoreHistoryArchive,
} from "@/shared/archive/history-restore";

/**
 * A month of the delivery history of one company, back from the archive
 * bucket into a table of its own, for a legal request (plano-escala F5-16;
 * src/shared/archive/history-restore.ts does the work and says what it
 * checks).
 *
 *   production container:
 *     node build/archive-restore.js <tabela> <AAAAMM|older> <businessId|_platform> [nome]
 *   development:
 *     yarn archive:restore delivery_event 2026-11 <businessId>
 *
 * It reads the archive's settings of the container (TRAIL_ARCHIVE_BUCKET,
 * ARCHIVE_R2_ACCESS_KEY_ID, ARCHIVE_R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID) and
 * creates the table in the `archive_restore` schema, which the API's own
 * login may not do: run it with DATABASE_URL set, for this one command, to
 * the Database's own user (the URL of trajetto-api-migrate). The table is
 * the requester's to read and to drop (DROP TABLE archive_restore.<nome>)
 * once the request is answered: it holds a company's history outside every
 * screen and every rule of the product.
 *
 * Exit status: 0 restored; 1 refused (the reason is printed) or failed.
 */
async function main(): Promise<void> {
  const [table, period, subject, into] = process.argv.slice(2);

  if (!table || !period || !subject) {
    console.error(
      "uso: archive-restore <delivery_event|activity> <AAAAMM|AAAA-MM|older> <businessId|_platform> [nome da tabela]",
    );
    process.exitCode = 1;
    return;
  }

  const storage = archiveStorageFromEnv(env);

  if (!storage) {
    console.error(
      `[archive-restore] arquivo sem configuração: ${missingArchiveSettings(env).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const result = await restoreHistoryArchive(
    { table, period, subject, into },
    { db: database, storage },
  );

  console.log(JSON.stringify({ result: "ok", ...result }));
}

main()
  .catch((error) => {
    console.error(
      "[archive-restore] Falhou:",
      error instanceof ArchiveRestoreError ? error.message : error,
    );
    process.exitCode = 1;
  })
  .finally(() => database.$disconnect());
