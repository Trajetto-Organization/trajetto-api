import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";
import { defineConfig, env } from "prisma/config";

/**
 * The Prisma CLI's configuration (Prisma 7): `generate`, `migrate deploy`,
 * `migrate diff`, `studio`.
 *
 * Prisma 6 read `.env` by itself and expanded `${POSTGRES_HOST}`-style
 * placeholders in it; Prisma 7 reads nothing. The app expands them with
 * dotenv + dotenv-expand (src/env), and so does this file, so `yarn prisma
 * migrate deploy` keeps working from a developer's `.env`. A variable already
 * in the environment wins over the file, as before: the container's
 * entrypoint passes DATABASE_URL="$SCHEMA_URL" explicitly.
 *
 * The datasource is only declared when DATABASE_URL exists: `prisma generate`
 * runs in the image's build stage, where there is no database, and needs none.
 * A command that does need one fails with Prisma's own "datasource.url is
 * required" instead of a placeholder URL.
 */
dotenvExpand.expand(dotenv.config());

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  ...(process.env.DATABASE_URL
    ? { datasource: { url: env("DATABASE_URL") } }
    : {}),
});
