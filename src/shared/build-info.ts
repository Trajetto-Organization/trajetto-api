import { z } from "zod";

/**
 * The commit this process was built from.
 *
 * The Dockerfile turns the `GIT_SHA` build arg (deploy.yml passes the commit
 * of the push) into `APP_COMMIT_SHA`, and GET /health/liveness answers it.
 * That is how the pipeline proves, from outside and without SSH, that the
 * build it just deployed is the one serving
 * (.github/scripts/wait-for-version.mjs): Dokploy's `done` only means Swarm
 * ACCEPTED the new spec, and a replica that fails its healthcheck is rolled
 * back while the old build keeps answering.
 *
 * Not a secret: a commit names a build, and says nothing about how to reach
 * anything. Read once, at import, so the liveness probe stays a constant and
 * touches nothing.
 */
export interface BuildInfo {
  /** The first 7 characters (the image's `sha-<7>` tag); "dev" without one. */
  version: string;
  /** The full commit; null in a build that was given none (a local one). */
  commit: string | null;
}

const COMMIT = /^[0-9a-f]{7,40}$/;

/** Anything that is not 7-40 hex digits reads as a build with no commit. */
export function readBuildInfo(
  env: Record<string, string | undefined> = process.env,
): BuildInfo {
  const raw = (env.APP_COMMIT_SHA ?? "").trim().toLowerCase();

  return COMMIT.test(raw)
    ? { version: raw.slice(0, 7), commit: raw }
    : { version: "dev", commit: null };
}

export const buildInfo: Readonly<BuildInfo> = Object.freeze(readBuildInfo());

/** The fields the liveness body carries, for its OpenAPI response schema. */
export const buildInfoShape = {
  version: z
    .string()
    .describe(
      "Os 7 primeiros caracteres do commit deste build (a tag `sha-<7>` da imagem); `dev` num build sem commit.",
    ),
  commit: z
    .string()
    .nullable()
    .describe("O commit completo deste build; `null` num build local."),
};
