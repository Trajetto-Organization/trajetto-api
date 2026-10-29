import { beforeEach, describe, expect, it } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { IWhatsAppProvider } from "@/shared/providers/whatsapp-provider/IWhatsApp-provider";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";

import { GetWhatsAppSettingsUseCase } from "@/modules/whatsapp/usecases/manage-settings/get-whatsapp-settings-usecase";
import { UpdateWhatsAppSettingsUseCase } from "@/modules/whatsapp/usecases/manage-settings/update-whatsapp-settings-usecase";

/**
 * A person's WhatsApp notification settings (TEST-UC-1). The provider is
 * only asked whether it is configured; the uniqueness of an enabled number
 * is the twin's query, which mirrors the Prisma one (enabled, not revoked).
 */
const ANA = "018f3500-0000-7000-8000-0000000000a1";
const BRUNO = "018f3500-0000-7000-8000-0000000000a2";
const REVOKED = "018f3500-0000-7000-8000-0000000000a3";
const UNKNOWN = "018f3500-0000-7000-8000-0000000000ff";

let users: InMemoryUserRepository;
let configured: boolean;

const provider = {
  isConfigured: () => configured,
} as unknown as IWhatsAppProvider;

beforeEach(() => {
  configured = true;
  users = new InMemoryUserRepository();

  users.user.push(
    {
      id: ANA,
      role: "BUSINESS_USER",
      businessId: "b-1",
      whatsapp_notifications_enabled: false,
      whatsapp_phone: null,
      access_revoked: false,
    } as unknown as User,
    {
      id: BRUNO,
      role: "BUSINESS_USER",
      businessId: "b-2",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "11999998888",
      access_revoked: false,
    } as unknown as User,
    {
      id: REVOKED,
      role: "BUSINESS_USER",
      businessId: "b-1",
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "11977776666",
      access_revoked: true,
    } as unknown as User,
  );
});

const read = () => new GetWhatsAppSettingsUseCase(users, provider);
const save = () => new UpdateWhatsAppSettingsUseCase(users, provider);

describe("reading the WhatsApp settings", () => {
  it("answers off with no number for a fresh account, and whether the service is configured", async () => {
    await expect(read().execute(ANA)).resolves.toEqual({
      enabled: false,
      phoneNumber: undefined,
      serviceConfigured: true,
    });

    configured = false;
    await expect(read().execute(BRUNO)).resolves.toEqual({
      enabled: true,
      phoneNumber: "11999998888",
      serviceConfigured: false,
    });
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(read().execute(UNKNOWN)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});

describe("saving the WhatsApp settings", () => {
  it("enables with a number", async () => {
    const result = await save().execute({
      userId: ANA,
      enabled: true,
      phoneNumber: "11912345678",
    });

    expect(result).toEqual({
      enabled: true,
      phoneNumber: "11912345678",
      serviceConfigured: true,
    });
    expect(users.user[0]).toMatchObject({
      whatsapp_notifications_enabled: true,
      whatsapp_phone: "11912345678",
    });
  });

  it("refuses enabling without a number (400)", async () => {
    await expect(
      save().execute({ userId: ANA, enabled: true }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: "WHATSAPP_NUMBER_REQUIRED",
    });
  });

  it("refuses a number another enabled account holds (409), and saves nothing", async () => {
    await expect(
      save().execute({
        userId: ANA,
        enabled: true,
        phoneNumber: "11999998888",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "WHATSAPP_PHONE_TAKEN" });

    expect(users.user[0].whatsapp_notifications_enabled).toBe(false);
  });

  it("lets a number kept by a revoked account be used", async () => {
    await expect(
      save().execute({
        userId: ANA,
        enabled: true,
        phoneNumber: "11977776666",
      }),
    ).resolves.toMatchObject({ enabled: true });
  });

  it("lets the holder save their own number again", async () => {
    await expect(
      save().execute({
        userId: BRUNO,
        enabled: true,
        phoneNumber: "11999998888",
      }),
    ).resolves.toMatchObject({ enabled: true, phoneNumber: "11999998888" });
  });

  it("keeps the number on disable, and a kept number blocks nobody", async () => {
    const result = await save().execute({ userId: BRUNO, enabled: false });

    expect(result).toEqual({
      enabled: false,
      phoneNumber: "11999998888",
      serviceConfigured: true,
    });
    expect(users.user[1].whatsapp_phone).toBe("11999998888");

    await expect(
      save().execute({
        userId: ANA,
        enabled: true,
        phoneNumber: "11999998888",
      }),
    ).resolves.toMatchObject({ enabled: true });
  });

  it("refuses an unknown caller (404)", async () => {
    await expect(
      save().execute({ userId: UNKNOWN, enabled: false }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
