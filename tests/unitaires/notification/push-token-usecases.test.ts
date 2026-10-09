import "reflect-metadata";

import { beforeEach, describe, expect, it } from "vitest";

import {
  RegisterPushTokenUseCase,
  RemovePushTokenUseCase,
} from "@/modules/notification/usecases/manage-push-token/manage-push-token-usecase";
import { InMemoryPushDeviceTokenRepository } from "@/modules/notification/repositories/in-memory/in-memory-push-device-token-repository";
import { ResourceNotFoundError } from "@/modules/user/usecases/errors/resource-not-found-error";

/**
 * Register/RemovePushToken on the twin (TEST-ARCH-1): the token follows the
 * login that registered it last, and only its owner can remove it.
 */
const ANA = { id: "ana", businessId: "A", role: "BUSINESS_USER", driverId: "d-ana" };
const BIA = { id: "bia", businessId: "B", role: "BUSINESS_USER", driverId: "d-bia" };

const users = [ANA, BIA];
const userRepository = {
  findUserById: async (id: string) => users.find((user) => user.id === id) ?? null,
} as never;

let devices: InMemoryPushDeviceTokenRepository;
let register: RegisterPushTokenUseCase;
let remove: RemovePushTokenUseCase;

beforeEach(() => {
  devices = new InMemoryPushDeviceTokenRepository(new Set(users.map((user) => user.id)));
  register = new RegisterPushTokenUseCase(userRepository, devices);
  remove = new RemovePushTokenUseCase(devices);
});

describe("RegisterPushTokenUseCase", () => {
  it("registers the device for the caller's session", async () => {
    await register.execute({ userId: ANA.id, sessionId: "s1", token: "tk", platform: "android" });

    expect(devices.devices).toMatchObject([
      { token: "tk", platform: "android", userId: ANA.id, session_family_id: "s1" },
    ]);
  });

  it("moves the phone to whoever signs in on it next, even from another company", async () => {
    await register.execute({ userId: ANA.id, sessionId: "s1", token: "tk", platform: "android" });
    await register.execute({ userId: BIA.id, sessionId: "s2", token: "tk", platform: "android" });

    expect(devices.devices).toHaveLength(1);
    expect(devices.devices[0]).toMatchObject({ userId: BIA.id, session_family_id: "s2" });
  });

  it("answers a session user who no longer exists with 404 USER_NOT_FOUND and writes nothing", async () => {
    const attempt = register.execute({ userId: "gone", sessionId: "s", token: "tk", platform: "android" });

    await expect(attempt).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(attempt).rejects.toMatchObject({ statusCode: 404, code: "USER_NOT_FOUND" });
    expect(devices.devices).toEqual([]);
  });

  it("lets a storage failure reach the caller instead of answering success", async () => {
    devices.register = async () => {
      throw new Error("connection reset");
    };

    await expect(
      register.execute({ userId: ANA.id, sessionId: "s", token: "tk", platform: "android" }),
    ).rejects.toThrow("connection reset");
  });
});

describe("RemovePushTokenUseCase", () => {
  beforeEach(async () => {
    await register.execute({ userId: ANA.id, sessionId: "s1", token: "tk-ana", platform: "android" });
  });

  it("removes the caller's own device", async () => {
    await remove.execute({ userId: ANA.id, token: "tk-ana" });

    expect(devices.devices).toEqual([]);
  });

  it("does not let one user unregister another's device", async () => {
    await remove.execute({ userId: BIA.id, token: "tk-ana" });

    expect(devices.devices).toHaveLength(1);
  });

  it("is idempotent: removing twice succeeds both times", async () => {
    await remove.execute({ userId: ANA.id, token: "tk-ana" });
    await expect(remove.execute({ userId: ANA.id, token: "tk-ana" })).resolves.toBeUndefined();
  });
});
