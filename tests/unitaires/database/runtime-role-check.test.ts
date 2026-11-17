import { describe, expect, it, vi } from "vitest";

import { DatabaseUnavailableError } from "@/shared/database/pg-driver";
import type { DdlConnection } from "@/shared/database/ddl-connection";
import {
  checkRuntimeRoleAtBoot,
  judgeRuntimeRole,
  verifyRuntimeRole,
  type RuntimeRole,
} from "@/shared/database/runtime-role-check";

/**
 * The boot's check of the cut of the database roles (plano-escala F3-21).
 *
 * The runtime connects today as the owner of every table, a superuser, and
 * the cut is a URL the owner types by hand in each Application: easy to
 * forget, easy to undo with an old Environment. So every boot says it, and
 * with DATABASE_REQUIRE_RUNTIME_ROLE=true it refuses to start. A process
 * that runs the cron also needs the batch login and a DDL connection that
 * can act as the partitions' owner: without them, tomorrow's partitions of
 * the positions are not created and the pings of the day after are lost,
 * in silence, a day later — so that is refused at the boot too.
 *
 * And what the check must never do: stop a boot without the flag, or
 * because the database did not answer.
 */
const OWNER: RuntimeRole = {
  user: "trajetto",
  superuser: true,
  tablesOwner: true,
};
const MIGRATOR: RuntimeRole = {
  user: "trajetto_migrate",
  superuser: false,
  tablesOwner: true,
};
const HTTP: RuntimeRole = {
  user: "trajetto_http",
  superuser: false,
  tablesOwner: false,
};

const BATCH_URL = "postgresql://trajetto_batch:x@db.example.com:5432/trajetto";

describe("judgeRuntimeRole", () => {
  it("only warns about the owner without the flag, whatever else is missing", () => {
    const verdict = judgeRuntimeRole({
      role: OWNER,
      require: false,
      runsCron: true,
      batchUrl: undefined,
      partitionRole: { state: "not-checked" },
    });

    expect(verdict.fatal).toEqual([]);
    expect(verdict.warnings).toEqual([
      expect.stringContaining("como trajetto, superusuário"),
    ]);
  });

  it("names the tables' owner that is not a superuser", () => {
    const verdict = judgeRuntimeRole({
      role: MIGRATOR,
      require: false,
      runsCron: false,
      batchUrl: undefined,
      partitionRole: { state: "not-checked" },
    });

    expect(verdict.warnings).toEqual([
      expect.stringContaining("dono das tabelas"),
    ]);
  });

  it("refuses the owner with the flag", () => {
    const verdict = judgeRuntimeRole({
      role: OWNER,
      require: true,
      runsCron: false,
      batchUrl: undefined,
      partitionRole: { state: "not-checked" },
    });

    expect(verdict.fatal).toEqual([
      expect.stringContaining("DATABASE_REQUIRE_RUNTIME_ROLE=true recusa"),
    ]);
    expect(verdict.warnings).toEqual([]);
  });

  it("refuses a process with the cron and no BATCH_DATABASE_URL, with the flag", () => {
    const verdict = judgeRuntimeRole({
      role: HTTP,
      require: true,
      runsCron: true,
      batchUrl: undefined,
      partitionRole: { state: "not-checked" },
    });

    expect(verdict.fatal).toEqual([
      expect.stringContaining("falta a BATCH_DATABASE_URL"),
    ]);
  });

  it("does not ask a process without the cron for the batch URL", () => {
    expect(
      judgeRuntimeRole({
        role: HTTP,
        require: true,
        runsCron: false,
        batchUrl: undefined,
        partitionRole: { state: "not-checked" },
      }),
    ).toEqual({ fatal: [], warnings: [] });
  });

  it("refuses a batch login that cannot act as the partitions' owner, with the flag", () => {
    const verdict = judgeRuntimeRole({
      role: HTTP,
      require: true,
      runsCron: true,
      batchUrl: BATCH_URL,
      partitionRole: { state: "refused", detail: "o login não é membro" },
    });

    expect(verdict.fatal).toEqual([
      expect.stringContaining("não consegue SET ROLE trajetto_partitions"),
    ]);
  });

  it("lets the cut through: http for the requests, a batch that can act as the owner", () => {
    expect(
      judgeRuntimeRole({
        role: HTTP,
        require: true,
        runsCron: true,
        batchUrl: BATCH_URL,
        partitionRole: { state: "ok" },
      }),
    ).toEqual({ fatal: [], warnings: [] });
  });

  it("never stops a boot for a database that did not answer", () => {
    expect(
      judgeRuntimeRole({
        role: null,
        require: true,
        runsCron: true,
        batchUrl: BATCH_URL,
        partitionRole: { state: "unreachable", detail: "ECONNREFUSED" },
      }),
    ).toEqual({ fatal: [], warnings: [] });
  });
});

describe("verifyRuntimeRole", () => {
  const quiet = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

  const client = (role: RuntimeRole | Error) => ({
    $queryRawUnsafe: vi.fn(async () => {
      if (role instanceof Error) throw role;

      return [role];
    }),
  });

  const ddl = (canAct: boolean | Error) => {
    const close = vi.fn(async () => undefined);
    const connection = {
      canActAsPartitionOwner: vi.fn(async () => {
        if (canAct instanceof Error) throw canAct;

        return canAct;
      }),
      close,
    } as unknown as DdlConnection;

    return { open: vi.fn(async () => connection), close };
  };

  it("warns and lets the boot go on as the owner, without the flag", async () => {
    const log = quiet();

    await expect(
      verifyRuntimeRole({
        client: client(OWNER) as never,
        require: false,
        runsCron: true,
        batchUrl: undefined,
        log,
      }),
    ).resolves.toMatchObject({ fatal: [] });

    expect(log.warn).toHaveBeenCalledWith(
      { user: "trajetto" },
      expect.stringContaining("superusuário"),
    );
  });

  it("throws every reason with the flag", async () => {
    await expect(
      verifyRuntimeRole({
        client: client(OWNER) as never,
        require: true,
        runsCron: true,
        batchUrl: undefined,
        log: quiet(),
      }),
    ).rejects.toThrow(/superusuário[\s\S]*falta a BATCH_DATABASE_URL/);
  });

  it("asks the batch login for SET ROLE, and closes the connection", async () => {
    const refused = ddl(false);

    await expect(
      verifyRuntimeRole({
        client: client(HTTP) as never,
        require: true,
        runsCron: true,
        batchUrl: BATCH_URL,
        openDdl: refused.open,
        log: quiet(),
      }),
    ).rejects.toThrow("não consegue SET ROLE trajetto_partitions");

    expect(refused.open).toHaveBeenCalledWith(BATCH_URL);
    expect(refused.close).toHaveBeenCalled();

    const accepted = ddl(true);

    await expect(
      verifyRuntimeRole({
        client: client(HTTP) as never,
        require: true,
        runsCron: true,
        batchUrl: BATCH_URL,
        openDdl: accepted.open,
        log: quiet(),
      }),
    ).resolves.toEqual({ fatal: [], warnings: [] });
  });

  it("refuses a batch login Postgres rejects (wrong password), with the flag", async () => {
    await expect(
      verifyRuntimeRole({
        client: client(HTTP) as never,
        require: true,
        runsCron: true,
        batchUrl: BATCH_URL,
        openDdl: async () => {
          throw Object.assign(new Error("password authentication failed"), {
            code: "28P01",
          });
        },
        log: quiet(),
      }),
    ).rejects.toThrow("login recusado (SQLSTATE 28P01)");
  });

  it("lets the boot go on when neither connection answers, even with the flag", async () => {
    const log = quiet();

    await expect(
      verifyRuntimeRole({
        client: client(
          new DatabaseUnavailableError(new Error("down"), "connect-failed"),
        ) as never,
        require: true,
        runsCron: true,
        batchUrl: BATCH_URL,
        openDdl: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED"), {
            code: "ECONNREFUSED",
          });
        },
        log,
      }),
    ).resolves.toEqual({ fatal: [], warnings: [] });

    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("does not open the batch connection without the flag", async () => {
    const probe = ddl(true);

    await verifyRuntimeRole({
      client: client(HTTP) as never,
      require: false,
      runsCron: true,
      batchUrl: BATCH_URL,
      openDdl: probe.open,
      log: quiet(),
    });

    expect(probe.open).not.toHaveBeenCalled();
  });
});

describe("checkRuntimeRoleAtBoot", () => {
  // A database that drops packets leaves the connection hanging until its
  // own timeout. The boot did not wait for the database before this check;
  // it must not start to because of it.
  it("gives up past its deadline and lets the boot go on", async () => {
    const error = vi.fn();
    const hanging = {
      $queryRawUnsafe: vi.fn(() => new Promise<never>(() => undefined)),
    };

    await expect(
      checkRuntimeRoleAtBoot({
        client: hanging as never,
        require: true,
        runsCron: false,
        batchUrl: undefined,
        deadlineMs: 20,
        log: { info: vi.fn(), warn: vi.fn(), error },
      }),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(
      { deadlineMs: 20 },
      "database role not checked at boot: no answer within the deadline",
    );
  });

  it("still refuses in time with the flag", async () => {
    await expect(
      checkRuntimeRoleAtBoot({
        client: { $queryRawUnsafe: async () => [OWNER] } as never,
        require: true,
        runsCron: false,
        batchUrl: undefined,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow("superusuário");
  });
});
