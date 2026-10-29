import { hostname } from "node:os";
import { Writable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();

  return {
    env: new Proxy(actual.env, {
      get: (target, key) =>
        key === "APP_ENV" ? "staging" : target[key as keyof typeof target],
    }),
  };
});

import { buildLogger } from "@/shared/logging/logger";

/**
 * Staging and production run the same image and log to the same kind of
 * sink (ENV-1, decision 12.2). Without the environment on the line, a staging
 * error read like a production one in any shared log view.
 */
describe("the process logger", () => {
  it("stamps every line with APP_ENV and keeps pid and hostname", () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });

    buildLogger(sink).warn({ component: "probe" }, "a line");

    const line = JSON.parse(lines[0]);

    expect(line).toMatchObject({
      app_env: "staging",
      pid: process.pid,
      hostname: hostname(),
      component: "probe",
      msg: "a line",
    });
  });
});
