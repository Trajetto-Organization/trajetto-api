import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ACTIVITY_STATUS_CATALOG,
  ACTIVITY_STATUS_VALUES,
  ACTIVITY_TYPE_VALUES,
  canonicalStatus,
  storedStatusesFor,
} from "@/modules/activity/activity-catalog";
import { InMemoryActivityRepository } from "@/modules/activity/repositories/in-memory/in-memory-activity-repository";

import { DELIVERY_STATUS_LABELS } from "@/shared/delivery/delivery-rules";
import { ROUTE_STATUS_LABELS } from "@/shared/route/route-rules";
import { translateVehicleStatus } from "@/shared/utils/format-values";

import {
  DRIVER_ROLE,
  PLATFORM_ROLE,
  presentActivityActor,
} from "@/shared/activity/actor-presentation";

/**
 * One catalog of what the activity trail records (FLEET-ACT-2/4/5): every
 * status and type a writer uses is known to the filter and to the badges,
 * and legacy spellings are found by their canonical value.
 */

const SRC = join(__dirname, "..", "..", "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);

    if (statSync(path).isDirectory()) return sourceFiles(path);

    return path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * The literals written as an activity's status and type: an object with an
 * `action: "create" | "update" | "delete"` is an activity (or its render),
 * and its `status:` / `type:` lines are within a few lines of it.
 */
function writtenLiterals(): { statuses: Set<string>; types: Set<string> } {
  const statuses = new Set<string>();
  const types = new Set<string>();

  for (const file of sourceFiles(SRC)) {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);

    lines.forEach((line, index) => {
      if (!/\baction:\s*"(create|update|delete)"/.test(line)) return;

      const window = lines.slice(Math.max(0, index - 8), index + 12);

      for (const near of window) {
        const status = /^\s*status:\s*(.+?),?\s*$/.exec(near);
        // A capitalised pt-BR word: socket and outbox payloads nearby carry
        // lowercase event types ("route.cancelled") that are not activities.
        const type = /^\s*type:\s*"([A-ZÀ-Ý][a-zà-ÿ][^"]*)"/.exec(near);

        if (status) {
          for (const literal of status[1].matchAll(/"([^"]+)"/g)) {
            statuses.add(literal[1]);
          }
        }

        if (type) types.add(type[1]);
      }
    });
  }

  return { statuses, types };
}

describe("the activity catalog", () => {
  it("knows every status literal a writer records", () => {
    const { statuses } = writtenLiterals();

    // The scan must be finding the writers, or it proves nothing.
    expect(statuses.size).toBeGreaterThan(10);

    const unknown = [...statuses].filter(
      (status) =>
        !(ACTIVITY_STATUS_VALUES as readonly string[]).includes(
          canonicalStatus(status),
        ),
    );

    expect(unknown).toEqual([]);
  });

  it("knows every type literal a writer records", () => {
    const { types } = writtenLiterals();

    expect(types.size).toBeGreaterThan(10);

    const unknown = [...types].filter(
      (type) => !(ACTIVITY_TYPE_VALUES as readonly string[]).includes(type),
    );

    expect(unknown).toEqual([]);
  });

  it("covers the label maps the writers look statuses up in", () => {
    const labels = [
      ...Object.values(DELIVERY_STATUS_LABELS),
      ...Object.values(ROUTE_STATUS_LABELS),
      ...(["ACTIVE", "INACTIVE", "BLOCKED", "IN_ROUTE"] as const).map(
        translateVehicleStatus,
      ),
    ];

    for (const label of labels) {
      expect(ACTIVITY_STATUS_VALUES as readonly string[]).toContain(
        canonicalStatus(label),
      );
    }
  });

  it("maps legacy spellings to one canonical status and back", () => {
    expect(canonicalStatus("Em Rota")).toBe("Em rota");
    expect(canonicalStatus("PLANNED")).toBe("Planejada");
    expect(canonicalStatus("Algo novo")).toBe("Algo novo");

    expect(storedStatusesFor(["Em rota"]).sort()).toEqual(
      ["Em rota", "Em Rota", "IN_ROUTE", "IN_TRANSIT"].sort(),
    );

    // Each canonical value appears once, and no alias is another value.
    const values = ACTIVITY_STATUS_CATALOG.map((entry) => entry.value);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("the trail stores one spelling", () => {
  it("normalises a raw enum or a variant on write", async () => {
    const repository = new InMemoryActivityRepository();

    const written = await repository.createActivity({
      type: "Rota",
      action: "update",
      entityId: "route-1",
      description: "Rota atualizada",
      status: "PLANNED",
      performedBy: "user-1",
      businessId: "biz-1",
    });

    expect(written.status).toBe("Planejada");
  });
});

describe("activity actor presentation", () => {
  it("presents a driver acting from the app as DRIVER, for every reader, without the link", () => {
    const row = {
      id: "1",
      user: {
        name: "João",
        email: "joao@empresa.com",
        role: "BUSINESS_USER",
        driverId: "drv-1",
      },
    };

    for (const viewer of ["MASTER", "BUSINESS_ADMIN"]) {
      const seen = presentActivityActor(row, viewer);

      expect(seen.user).toEqual({
        name: "João",
        email: "joao@empresa.com",
        role: DRIVER_ROLE,
      });
    }
  });

  it("keeps a collaborator as BUSINESS_USER and the platform masked for a company", () => {
    const collaborator = presentActivityActor(
      {
        id: "2",
        user: {
          name: "Ana",
          email: "a@e.com",
          role: "BUSINESS_USER",
          driverId: null,
        },
      },
      "BUSINESS_ADMIN",
    );

    expect(collaborator.user).toEqual({
      name: "Ana",
      email: "a@e.com",
      role: "BUSINESS_USER",
    });

    const master = presentActivityActor(
      {
        id: "3",
        user: { name: "Op", email: "op@t.com", role: "MASTER", driverId: null },
      },
      "BUSINESS_ADMIN",
    );

    expect(master.user?.role).toBe(PLATFORM_ROLE);
    expect(master.user?.email).toBeNull();
  });

  it("drops the row's own copies of the operator's identity for a company, keeps them for MASTER", () => {
    const row = {
      id: "4",
      performedBy: "operator-id",
      performingUserRole: "MASTER",
      user: { name: "Op", email: "op@t.com", role: "MASTER", driverId: null },
    };

    const company = presentActivityActor(row, "BUSINESS_ADMIN");

    expect(company).toMatchObject({
      performedBy: null,
      performingUserRole: null,
    });
    expect(JSON.stringify(company)).not.toContain("operator-id");
    expect(JSON.stringify(company)).not.toContain("op@t.com");

    expect(presentActivityActor(row, "MASTER")).toMatchObject({
      performedBy: "operator-id",
      performingUserRole: "MASTER",
      user: { email: "op@t.com", role: "MASTER" },
    });
  });
});

describe("the author-role facet agrees with the presentation", () => {
  it("files an admin linked to a driver under BUSINESS_ADMIN only, never under DRIVER", async () => {
    const repository = new InMemoryActivityRepository();

    repository.users.set("admin-driver", {
      role: "BUSINESS_ADMIN",
      businessId: "biz-1",
      driverId: "drv-9",
      name: "Gestora",
      email: "g@empresa.com",
    });
    repository.users.set("app-driver", {
      role: "BUSINESS_USER",
      businessId: "biz-1",
      driverId: "drv-1",
      name: "João",
      email: "j@empresa.com",
    });

    repository.addActivity({
      id: "a1",
      performedBy: "admin-driver",
      businessId: "biz-1",
    });
    repository.addActivity({
      id: "a2",
      performedBy: "app-driver",
      businessId: "biz-1",
    });

    const list = (role: "DRIVER" | "BUSINESS_ADMIN") =>
      repository.listAllActivities({
        page: 1,
        pageSize: 10,
        currentUserRole: "MASTER",
        userId: "master",
        roles: [role],
      });

    const drivers = await list("DRIVER");
    const admins = await list("BUSINESS_ADMIN");

    expect(drivers.data.map((row) => row.id)).toEqual(["a2"]);
    expect(admins.data.map((row) => row.id)).toEqual(["a1"]);
    // Each row is presented as the facet that found it.
    expect((drivers.data[0] as { user?: { role: string } }).user?.role).toBe(
      DRIVER_ROLE,
    );
    expect((admins.data[0] as { user?: { role: string } }).user?.role).toBe(
      "BUSINESS_ADMIN",
    );
  });
});

describe("the search does not confirm the platform operator's identity", () => {
  it("finds a platform row by the operator's e-mail or id only for the MASTER", async () => {
    const repository = new InMemoryActivityRepository();

    repository.users.set("operator", {
      role: "MASTER",
      businessId: null,
      driverId: null,
      name: "Operadora",
      email: "operadora.pessoal@exemplo.com",
    });
    repository.users.set("manager", {
      role: "BUSINESS_ADMIN",
      businessId: "biz-1",
      driverId: null,
      name: "Gestora",
      email: "gestora@empresa.com",
    });

    repository.addActivity({
      id: "plan",
      performedBy: "operator",
      businessId: "biz-1",
      visibilityLevel: "TENANT_VISIBLE",
    });
    repository.addActivity({
      id: "own",
      performedBy: "manager",
      businessId: "biz-1",
    });

    const search = (term: string, role: "MASTER" | "BUSINESS_ADMIN") =>
      repository.listAllActivities({
        page: 1,
        pageSize: 10,
        currentUserRole: role,
        userId: role === "MASTER" ? "operator" : "manager",
        search: term,
      });

    expect((await search("operadora.pessoal", "BUSINESS_ADMIN")).total).toBe(0);
    expect((await search("operator", "BUSINESS_ADMIN")).total).toBe(0);
    expect(
      (await search("gestora@", "BUSINESS_ADMIN")).data.map((row) => row.id),
    ).toEqual(["own"]);

    expect(
      (await search("operadora.pessoal", "MASTER")).data.map((row) => row.id),
    ).toEqual(["plan"]);
  });
});
