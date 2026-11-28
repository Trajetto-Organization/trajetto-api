import { describe, expect, it, vi } from "vitest";

import { NotificationCategory } from "@prisma/client";

import { notificationPolicies } from "@/shared/notifications/notification-policy";
import {
  driverAccessNewDevicePolicy,
  driverAccessPasswordCreatedPolicy,
} from "@/shared/notifications/policies/driver-access-policies";

import type { IUserRepository } from "@/modules/user/repositories/IUser-repository";
import type { User } from "@/modules/user/dtos/user-dto";
import type { DriverAccessPayload } from "@/shared/notifications/notification-types";

/**
 * The company hears when a driver's login is reached by a way it should see
 * (wave 2, 06/11/2026): the QR code consumed on a phone new to the login, and
 * a password created right after one. A QR code read out over the phone to
 * somebody posing as the driver ends up exactly there. The manager who issued
 * the code already knows and is left out.
 */
const CARRIER = "018f3700-0000-7000-8000-00000000000a";
const ISSUER = "018f3700-0000-7000-8000-0000000000a1";
const OTHER_ADMIN = "018f3700-0000-7000-8000-0000000000a2";

const payload: DriverAccessPayload = {
  businessId: CARRIER,
  driverUserId: "018f3700-0000-7000-8000-0000000000d1",
  driverName: "Maria Prado",
  issuedById: ISSUER,
  at: "2026-11-06T12:00:00.000Z",
};

const admins = [
  { id: ISSUER, role: "BUSINESS_ADMIN" },
  { id: OTHER_ADMIN, role: "BUSINESS_ADMIN" },
] as User[];

const deps = () => ({
  userRepository: {
    findBusinessAdminsByBusinessId: vi.fn(async () => admins),
  } as unknown as IUserRepository,
});

describe.each([
  ["driver-access.new_device", driverAccessNewDevicePolicy],
  ["driver-access.password_created", driverAccessPasswordCreatedPolicy],
] as const)("%s", (topic, policy) => {
  it("is registered, so the pipeline does not fail the event", () => {
    expect(notificationPolicies[topic]).toBe(policy);
  });

  it("goes to the company's admins, all but the manager who issued the QR code", async () => {
    const context = deps();

    const recipients = await policy.resolveRecipients(payload, context);

    expect(
      context.userRepository.findBusinessAdminsByBusinessId,
    ).toHaveBeenCalledWith(CARRIER);
    expect(recipients.map((user) => user.id)).toEqual([OTHER_ADMIN]);
  });

  it("goes to every admin when the issuer is gone", async () => {
    const recipients = await policy.resolveRecipients(
      { ...payload, issuedById: null },
      deps(),
    );

    expect(recipients.map((user) => user.id)).toEqual([ISSUER, OTHER_ADMIN]);
  });

  // In-app, and push where the admin has the app, by their preferences; the
  // security notice lives in the inbox, not in the mailbox, and there is no
  // approved WhatsApp template for it.
  it("is an account notice, in-app and push only", () => {
    expect(policy.category).toBe(NotificationCategory.ACCOUNT);
    expect(policy.mandatory).toBeUndefined();
    expect(policy.suppressEmail).toBe(true);
    expect(policy.renderWhatsApp).toBeUndefined();
    expect(policy.renderActivity).toBeUndefined();
  });

  it("names the driver and links to the users page searched by name, with no phone id", () => {
    const rendered = policy.renderInApp!(
      payload,
      { baseUrl: "https://app.trajetto.com.br" },
      { id: OTHER_ADMIN, role: "BUSINESS_ADMIN" },
    );

    expect(rendered.message).toContain("Maria Prado");
    expect(rendered.link).toBe(
      "https://app.trajetto.com.br/dashboard/user-registration?search=Maria%20Prado&page=1",
    );
    expect(rendered.entityId).toBe(payload.driverUserId);
    expect(rendered.type).toBe("driver-access");
  });
});

describe("the wording", () => {
  const ctx = { baseUrl: "https://app.trajetto.com.br" };
  const recipient = { id: OTHER_ADMIN, role: "BUSINESS_ADMIN" };

  it("says a new phone entered by the QR code, and what to do if it was not agreed", () => {
    const rendered = driverAccessNewDevicePolicy.renderInApp!(
      payload,
      ctx,
      recipient,
    );

    expect(rendered.title).toBe("Aparelho novo do motorista");
    expect(rendered.message).toMatch(/aparelho novo pelo QR Code/);
    expect(rendered.message).toMatch(/desconecte o aparelho/);
  });

  it("says a password was created after the QR code and the other sessions ended", () => {
    const rendered = driverAccessPasswordCreatedPolicy.renderInApp!(
      payload,
      ctx,
      recipient,
    );

    expect(rendered.title).toBe("Senha criada pelo motorista");
    expect(rendered.message).toMatch(/criou uma senha nova/);
    expect(rendered.message).toMatch(/outras sessões dele foram encerradas/);
  });
});
