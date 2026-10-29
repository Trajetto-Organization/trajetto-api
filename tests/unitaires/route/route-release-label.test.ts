import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The day the driver's "rota liberada" push names (decision 1.3), through
 * the real release-route wiring and in zones WEST of UTC.
 *
 * The route's day is a date-only value (UTC midnight). Formatted in the
 * process's zone it read "16/09" for the route of the 17th anywhere west of
 * UTC; the container happens to run in UTC, so a test in that same zone can
 * never see it. A vitest worker cannot change its own zone, so the release
 * runs in a child process with TZ set (fixtures/release-label-probe.ts).
 */
const PROBE = path.join(__dirname, "fixtures", "release-label-probe.ts");

function releaseIn(timeZone: string): { zone: string; label: string | null } {
  const result = spawnSync(process.execPath, ["--import", "tsx", PROBE], {
    cwd: path.resolve(__dirname, "..", "..", ".."),
    env: { ...process.env, TZ: timeZone },
    encoding: "utf8",
    timeout: 60_000,
  });

  if (result.status !== 0) {
    throw new Error(`probe failed (${result.status}): ${result.stderr}`);
  }

  return JSON.parse(result.stdout);
}

describe("the day in the release push, west of UTC", () => {
  it.each(["America/Manaus", "America/Sao_Paulo", "America/Rio_Branco"])(
    "names the route of the 17th as 17/09 in %s",
    (zone) => {
      const probe = releaseIn(zone);

      // The child really ran in that zone (otherwise the test proves nothing).
      expect(probe.zone).toBe(zone);

      // Red before: toLocaleDateString without a zone said "16/09" here.
      expect(probe.label).toBe("17/09");
    },
    60_000,
  );
});
