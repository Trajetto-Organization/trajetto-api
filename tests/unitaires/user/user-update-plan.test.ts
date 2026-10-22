import { describe, expect, it } from "vitest";

import {
  describeChanges,
  planUserUpdate,
  type UserSnapshot,
} from "@/modules/user/usecases/update-user/user-update-plan";

/**
 * The pure rule behind an edit of a user (decision 4.6): values are
 * compared with the stored row, and only a change of role or driver link
 * ends the sessions. The company is not an input: no edit moves a person
 * (decision 16.100).
 */
const employee: UserSnapshot = {
  role: "BUSINESS_USER",
  email: "ana@exemplo.com.br",
  name: "Ana Souza",
  businessId: "company-a",
  profileAccessId: "profile-ops",
  driverId: null,
};

const driverLogin: UserSnapshot = {
  ...employee,
  profileAccessId: null,
  driverId: "driver-1",
};

function ok(plan: ReturnType<typeof planUserUpdate>) {
  if (!plan.ok) throw new Error(`expected a plan, got ${plan.error}`);

  return plan;
}

describe("an edit that sends the stored values back", () => {
  it("is no change at all, whatever fields came in the body", () => {
    const plan = ok(
      planUserUpdate(employee, {
        email: "ana@exemplo.com.br",
        name: "Ana Souza",
        role: "BUSINESS_USER",
        profileAccessId: "profile-ops",
        driverId: "",
      }),
    );

    expect(plan.changed).toBe(false);
    expect(plan.endsSessions).toBe(false);
    expect(plan.data).toEqual({});
  });

  it("empty or null texts mean 'not sent', never a blank name", () => {
    const plan = ok(planUserUpdate(employee, { name: null, email: "" }));

    expect(plan.changed).toBe(false);
    expect(plan.next.name).toBe("Ana Souza");
  });
});

describe("what ends the sessions", () => {
  it.each([
    ["a rename", { name: "Ana Souza Lima" }, false],
    ["a new e-mail", { email: "ana.lima@exemplo.com.br" }, false],
    ["another profile", { profileAccessId: "profile-fin" }, false],
    ["a new role", { role: "BUSINESS_ADMIN" as const }, true],
  ])("%s → endsSessions %s", (_label, input, ends) => {
    const plan = ok(planUserUpdate(employee, input));

    expect(plan.changed).toBe(true);
    expect(plan.endsSessions).toBe(ends);
  });

  it("another driver for a driver login", () => {
    const plan = ok(planUserUpdate(driverLogin, { driverId: "driver-2" }));

    expect(plan.changes.driver).toBe(true);
    expect(plan.endsSessions).toBe(true);
  });
});

describe("the links", () => {
  it("an administrator carries neither a profile nor a driver", () => {
    const plan = ok(
      planUserUpdate(employee, {
        role: "BUSINESS_ADMIN",
        profileAccessId: "profile-ops",
      }),
    );

    expect(plan.next.profileAccessId).toBeNull();
    expect(plan.data).toMatchObject({
      role: "BUSINESS_ADMIN",
      profileAccessId: null,
    });
  });

  it("a profile alone replaces the driver link (USR-EDIT-3)", () => {
    const plan = ok(
      planUserUpdate(driverLogin, { profileAccessId: "profile-ops" }),
    );

    expect(plan.next).toMatchObject({
      profileAccessId: "profile-ops",
      driverId: null,
    });
    expect(plan.endsSessions).toBe(true);
  });

  it("a driver alone replaces the profile", () => {
    const plan = ok(planUserUpdate(employee, { driverId: "driver-9" }));

    expect(plan.next).toMatchObject({
      profileAccessId: null,
      driverId: "driver-9",
    });
  });

  it("both at once is refused", () => {
    expect(
      planUserUpdate(employee, { profileAccessId: "p", driverId: "d" }),
    ).toEqual({
      ok: false,
      error: "both_profile_and_driver",
    });
  });

  it("a user whose link is edited must end with one", () => {
    expect(planUserUpdate(employee, { profileAccessId: "" })).toEqual({
      ok: false,
      error: "assignment_required",
    });

    // Demoting an administrator without choosing a profile or driver.
    expect(
      planUserUpdate(
        { ...employee, role: "BUSINESS_ADMIN", profileAccessId: null },
        {
          role: "BUSINESS_USER",
        },
      ),
    ).toEqual({ ok: false, error: "assignment_required" });
  });

  it("a legacy user with neither can still have the name fixed", () => {
    const legacy = { ...employee, profileAccessId: null };

    expect(ok(planUserUpdate(legacy, { name: "Ana Souza Lima" })).changed).toBe(
      true,
    );
  });
});

describe("the company", () => {
  it("is never part of the plan, whatever the input carries", () => {
    // A caller that bypasses the schema still cannot move the person.
    const input = {
      businessId: "company-b",
      profileAccessId: "profile-b",
    } as Parameters<typeof planUserUpdate>[1];
    const plan = ok(planUserUpdate(employee, input));

    expect(plan.next.businessId).toBe("company-a");
    expect(plan.data).not.toHaveProperty("businessId");
    expect(plan.changes).not.toHaveProperty("business");
  });
});

describe("the audit wording", () => {
  it("names what changed, in the product's words", () => {
    const plan = ok(
      planUserUpdate(employee, { name: "Ana Lima", role: "BUSINESS_ADMIN" }),
    );

    expect(describeChanges(plan.changes)).toBe(
      "nome, nível de acesso, perfil de acesso",
    );
  });
});
