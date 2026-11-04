import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CONTEXT_FILE,
  apiUrls,
  forgetPreviousRun,
  replicaPorts,
  simDatabaseRefusal,
} from "./sim-config";

describe("simDatabaseRefusal", () => {
  it("accepts only trajetto_sim on the disposable container", () => {
    expect(
      simDatabaseRefusal(
        "postgresql://postgres:postgres@127.0.0.1:54321/trajetto_sim?schema=public",
        {},
      ),
    ).toBeNull();
  });

  it("refuses the container's other databases", () => {
    for (const name of [
      "trajetto",
      "trajetto_test_abc",
      "load_test",
      "postgres",
    ]) {
      expect(
        simDatabaseRefusal(
          `postgresql://postgres:postgres@127.0.0.1:54321/${name}`,
          {},
        ),
        name,
      ).toMatch(/trajetto_sim/);
    }
  });

  it("refuses the developer's Postgres and any remote host", () => {
    expect(
      simDatabaseRefusal(
        "postgresql://postgres:postgres@localhost:5432/trajetto_sim",
        {},
      ),
    ).not.toBeNull();
    expect(
      simDatabaseRefusal(
        "postgresql://postgres:postgres@10.0.0.5:54321/trajetto_sim",
        {},
      ),
    ).not.toBeNull();
    expect(simDatabaseRefusal(undefined, {})).not.toBeNull();
  });
});

describe("replicaPorts and apiUrls", () => {
  it("default to 3341 and 3342, replica A first", () => {
    expect(replicaPorts({})).toEqual([3341, 3342]);
    expect(apiUrls({})).toEqual([
      "http://127.0.0.1:3341",
      "http://127.0.0.1:3342",
    ]);
    expect(replicaPorts({ SIM_REPLICAS: "1" })).toEqual([3341]);
  });

  it("never take the dev API or the dev web ports", () => {
    expect(() => replicaPorts({ SIM_REPLICA_PORTS: "3333" })).toThrow(/3341/);
    expect(() => replicaPorts({ SIM_REPLICA_PORTS: "3341,3001" })).toThrow();
  });

  it("read SIM_API_URLS as given, without trailing slashes", () => {
    expect(
      apiUrls({
        SIM_API_URLS: "http://127.0.0.1:3341/, http://localhost:3342",
      }),
    ).toEqual(["http://127.0.0.1:3341", "http://localhost:3342"]);
  });

  it("refuse SIM_API_URLS on the dev API or web ports", () => {
    expect(() => apiUrls({ SIM_API_URLS: "http://127.0.0.1:3333" })).toThrow(
      /3333/,
    );
    expect(() =>
      apiUrls({ SIM_API_URLS: "http://localhost:3341,http://localhost:3001/" }),
    ).toThrow(/3001/);
  });

  it("refuse SIM_API_URLS off this machine (the replicas are local)", () => {
    for (const url of [
      "https://api.example.com",
      "http://10.0.0.5:3341",
      "not a url",
    ]) {
      expect(() => apiUrls({ SIM_API_URLS: url }), url).toThrow();
    }
  });
});

describe("forgetPreviousRun", () => {
  it("drops the context of the run whose database is being recreated", () => {
    const work = mkdtempSync(join(tmpdir(), "sim-forget-"));

    try {
      // A run that died mid-day leaves a context without finishedAt, and the
      // recorder would film that dead day with credentials that no longer exist.
      writeFileSync(join(work, CONTEXT_FILE), JSON.stringify({ admin: {} }));
      writeFileSync(join(work, "delivery-day-1.jsonl"), "");

      forgetPreviousRun({ SIM_WORK_DIR: work });

      expect(existsSync(join(work, CONTEXT_FILE))).toBe(false);
      // The logs are the evidence of past runs and stay.
      expect(existsSync(join(work, "delivery-day-1.jsonl"))).toBe(true);

      expect(() => forgetPreviousRun({ SIM_WORK_DIR: work })).not.toThrow();
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});
