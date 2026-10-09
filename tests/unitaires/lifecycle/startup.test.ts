import { describe, expect, it } from "vitest";

import { runStartup } from "@/shared/lifecycle/startup";

/**
 * The order a replica comes up in (OUTBOX-19).
 *
 * The backlog left by a deploy used to be drained before the Socket.IO server
 * existed: every in-app notification in it reached the bell with no toast.
 * The drain is now the LAST step, after realtime.
 */
function recorder() {
  const steps: string[] = [];

  const step = (name: string) => async () => {
    steps.push(name);
  };

  return {
    steps,
    options: {
      startWorkers: step("startWorkers"),
      listen: step("listen"),
      startRealtime: step("startRealtime"),
      drainBacklog: () => {
        steps.push("drainBacklog");
      },
    },
  };
}

describe("a replica starting", () => {
  it("drains the backlog only after realtime is up", async () => {
    const { steps, options } = recorder();

    await runStartup(options);

    expect(steps).toEqual([
      "startWorkers",
      "listen",
      "startRealtime",
      "drainBacklog",
    ]);
  });

  it("does not drain when realtime failed to start", async () => {
    const { steps, options } = recorder();

    await expect(
      runStartup({
        ...options,
        startRealtime: async () => {
          throw new Error("socket.io");
        },
      }),
    ).rejects.toThrow("socket.io");

    expect(steps).not.toContain("drainBacklog");
  });
});

describe("the proof signing certificate at boot (design §6.3)", () => {
  it("is opened before anything else, so a bad PFX shows in the deploy log", async () => {
    const { steps, options } = recorder();

    await runStartup({
      ...options,
      inspectCertificates: () => {
        steps.push("inspectCertificates");
      },
    });

    expect(steps).toEqual([
      "inspectCertificates",
      "startWorkers",
      "listen",
      "startRealtime",
      "drainBacklog",
    ]);
  });

  it("never stops the boot, even if the inspection throws", async () => {
    const { steps, options } = recorder();

    await runStartup({
      ...options,
      inspectCertificates: () => {
        throw new Error("pfx");
      },
    });

    expect(steps).toEqual([
      "startWorkers",
      "listen",
      "startRealtime",
      "drainBacklog",
    ]);
  });
});
