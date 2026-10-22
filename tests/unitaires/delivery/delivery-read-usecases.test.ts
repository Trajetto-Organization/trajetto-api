import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { User } from "@/modules/user/dtos/user-dto";
import type { CreateDeliveryProps } from "@/modules/delivery/dtos/delivery-dto";
import type { UploadService } from "@/shared/services/upload-service";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryDeliveryRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-repository";
import { InMemoryDeliveryMessageTemplateRepository } from "@/modules/delivery/repositories/in-memory/in-memory-delivery-message-template-repository";
import { InMemoryExternalRecipientRepository } from "@/modules/delivery/repositories/in-memory/in-memory-external-recipient-repository";

import { GetDeliveryUseCase } from "@/modules/delivery/usecases/get-delivery/get-delivery-usecase";
import { ListMessageTemplatesUseCase } from "@/modules/delivery/usecases/list-message-templates/list-message-templates-usecase";
import { TrackDeliveryUseCase } from "@/modules/delivery/usecases/track-delivery/track-delivery-usecase";

/**
 * Three reads of Entregas on the in-memory twins: a delivery's detail (whose
 * it is, and for a driver whether it is his), the company's message
 * templates, and the customer's public tracking page behind a bare token.
 */
const A = "018f5400-0000-7000-8000-00000000000a";
const B = "018f5400-0000-7000-8000-00000000000b";

const ADMIN_A = "018f5400-0000-7000-8000-0000000000a1";
const DRIVER_USER = "018f5400-0000-7000-8000-0000000000a2";
const OTHER_DRIVER_USER = "018f5400-0000-7000-8000-0000000000a3";
const ADMIN_B = "018f5400-0000-7000-8000-0000000000b1";
const MASTER = "018f5400-0000-7000-8000-0000000000f1";

const DRIVER = "018f5400-0000-7000-8000-0000000000d1";
const OTHER_DRIVER = "018f5400-0000-7000-8000-0000000000d2";

const uploadStub = {
  getFileUrl: async (key: string) => `https://signed.example/${key}`,
} as unknown as UploadService;

let users: InMemoryUserRepository;
let deliveries: InMemoryDeliveryRepository;

beforeEach(() => {
  users = new InMemoryUserRepository();
  deliveries = new InMemoryDeliveryRepository();

  users.user.push(
    { id: ADMIN_A, role: "BUSINESS_ADMIN", businessId: A } as User,
    {
      id: DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: DRIVER,
    } as User,
    {
      id: OTHER_DRIVER_USER,
      role: "BUSINESS_USER",
      businessId: A,
      driverId: OTHER_DRIVER,
    } as User,
    { id: ADMIN_B, role: "BUSINESS_ADMIN", businessId: B } as User,
    { id: MASTER, role: "MASTER", businessId: null } as unknown as User,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

async function delivery(businessId = A, driverId: string | null = DRIVER) {
  const created = await deliveries.createDelivery({
    recipient_name: "Mercado Sol",
    city: "São Paulo",
    uf: "SP",
    street: "Rua Um",
    businessId,
    shipperId: "018f5400-0000-7000-8000-0000000000c1",
  } as CreateDeliveryProps);

  created.driverId = driverId;

  return created.id!;
}

describe("GetDeliveryUseCase", () => {
  const get = () => new GetDeliveryUseCase(users, deliveries, uploadStub);

  it("returns the detail with storage keys signed at read time and the timeline built", async () => {
    const id = await delivery();
    deliveries.events.push({
      id: "018f5400-0000-7000-8000-00000000e001",
      deliveryId: id,
      businessId: A,
      type: "DELIVERED",
      photo: "proofs/photo.jpg",
      signature: "proofs/signature.png",
      created_at: new Date("2026-10-05T15:00:00.000Z"),
    } as never);

    const detail = (await get().execute({
      userId: ADMIN_A,
      businessId: A,
      deliveryId: id,
    })) as {
      id: string;
      events: Array<{ photo: string | null; signature: string | null }>;
      timeline: unknown[];
    };

    expect(detail.id).toBe(id);
    expect(detail.events[0]).toMatchObject({
      photo: "https://signed.example/proofs/photo.jpg",
      signature: "https://signed.example/proofs/signature.png",
    });
    expect(Array.isArray(detail.timeline)).toBe(true);
    expect(detail.timeline.length).toBeGreaterThan(0);
  });

  it("lets a driver open his own delivery only; a colleague's reads as missing", async () => {
    const id = await delivery();

    await expect(
      get().execute({ userId: DRIVER_USER, businessId: A, deliveryId: id }),
    ).resolves.toBeTruthy();
    await expect(
      get().execute({
        userId: OTHER_DRIVER_USER,
        businessId: A,
        deliveryId: id,
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DELIVERY_NOT_FOUND" });
  });

  it("answers another company's delivery, named under the caller's company, as missing", async () => {
    const foreign = await delivery(B, null);

    await expect(
      get().execute({ userId: ADMIN_A, businessId: A, deliveryId: foreign }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DELIVERY_NOT_FOUND" });
  });

  it("refuses a user of another company naming this company (403), MASTER allowed", async () => {
    const id = await delivery();

    // The use case used to trust the route guard alone for the path's company.
    await expect(
      get().execute({ userId: ADMIN_B, businessId: A, deliveryId: id }),
    ).rejects.toMatchObject({ statusCode: 403, code: "TENANT_ACCESS_DENIED" });

    await expect(
      get().execute({ userId: MASTER, businessId: A, deliveryId: id }),
    ).resolves.toBeTruthy();
  });

  it("answers 404 for an unknown delivery or session user", async () => {
    await expect(
      get().execute({
        userId: ADMIN_A,
        businessId: A,
        deliveryId: "018f5400-0000-7000-8000-0000000000ff",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "DELIVERY_NOT_FOUND" });

    const id = await delivery();
    await expect(
      get().execute({ userId: "nobody", businessId: A, deliveryId: id }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

describe("ListMessageTemplatesUseCase", () => {
  let templates: InMemoryDeliveryMessageTemplateRepository;

  beforeEach(async () => {
    templates = new InMemoryDeliveryMessageTemplateRepository();

    for (const [topic, channel, businessId] of [
      ["FAILED", "EMAIL", A],
      ["DISPATCHED", "WHATSAPP", A],
      ["DISPATCHED", "EMAIL", A],
      ["DELIVERED", "EMAIL", B],
    ] as const) {
      await templates.save({
        businessId,
        topic,
        channel,
        subject: null,
        body: `${topic} ${channel}`,
        is_active: true,
      } as never);
    }
  });

  const list = () => new ListMessageTemplatesUseCase(users, templates);

  it("lists the company's templates in the enum order, never another company's", async () => {
    const result = await list().execute({ userId: ADMIN_A });

    expect(result.total).toBe(3);
    expect(result.data.map((row) => `${row.topic}/${row.channel}`)).toEqual([
      "DISPATCHED/EMAIL",
      "DISPATCHED/WHATSAPP",
      "FAILED/EMAIL",
    ]);
  });

  it("refuses another company's templates (403) and asks the MASTER to pick one (400)", async () => {
    await expect(
      list().execute({ userId: ADMIN_A, businessId: B }),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: "TENANT_ACCESS_DENIED",
    });
    await expect(list().execute({ userId: MASTER })).rejects.toMatchObject({
      statusCode: 400,
      code: "BUSINESS_NOT_IDENTIFIED",
    });

    const picked = await list().execute({ userId: MASTER, businessId: B });
    expect(picked.total).toBe(1);
  });

  it("answers 404 USER_NOT_FOUND for an unknown session user", async () => {
    await expect(list().execute({ userId: "nobody" })).rejects.toMatchObject({
      statusCode: 404,
      code: "USER_NOT_FOUND",
    });
  });
});

describe("TrackDeliveryUseCase", () => {
  let recipients: InMemoryExternalRecipientRepository;

  async function trackable(expiresAt: Date | null = null) {
    recipients = new InMemoryExternalRecipientRepository();
    const recipient = await recipients.ensureForDelivery({
      deliveryId: "018f5400-0000-7000-8000-0000000000d9",
      businessId: A,
      name: "Cliente Final",
      email: "cliente@exemplo.com.br",
      telephone: "11999990000",
    } as never);
    recipient.expires_at = expiresAt;

    recipients.tracking.set(recipient.deliveryId, {
      delivery: {
        id: recipient.deliveryId,
        code: "PED-1",
        status: "IN_TRANSIT",
        invoice_number: "4512",
        recipient_name: "Cliente Final",
        city: "São Paulo",
        uf: "SP",
        scheduled_date: "2026-10-06",
        delivered_at: null,
        received_by: null,
        business: {
          corporate_reason: "Transportadora A Ltda",
          fantasy_name: "Transportadora A",
          timezone: "America/Sao_Paulo",
        },
      },
      events: [],
      occurrences: [],
      proofToken: null,
    } as never);

    return recipient.access_token;
  }

  it("opens the page for a live token, without the company's internals", async () => {
    const token = await trackable();

    const view = await new TrackDeliveryUseCase(recipients).execute({ token });

    expect(JSON.stringify(view)).toContain("Transportadora A");
    // The recipient's contact never goes back out on a public page.
    expect(JSON.stringify(view)).not.toContain("cliente@exemplo.com.br");
    expect(JSON.stringify(view)).not.toContain("11999990000");
  });

  it("answers a wrong token and an expired one with the same 404", async () => {
    const token = await trackable(new Date(Date.now() - 1000));
    const use = new TrackDeliveryUseCase(recipients);

    const expired = await use
      .execute({ token })
      .catch((error: unknown) => error);
    const wrong = await use
      .execute({ token: "0".repeat(64) })
      .catch((error: unknown) => error);

    expect(expired).toMatchObject({
      statusCode: 404,
      code: "TRACKING_NOT_FOUND",
      message: "Acompanhamento não encontrado.",
    });
    expect(wrong).toMatchObject({
      statusCode: 404,
      code: "TRACKING_NOT_FOUND",
      message: "Acompanhamento não encontrado.",
    });
  });

  it("keeps a link open until the very instant it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-06T12:00:00.000Z"));

    const token = await trackable(new Date("2026-10-06T12:00:00.000Z"));

    await expect(
      new TrackDeliveryUseCase(recipients).execute({ token }),
    ).resolves.toBeTruthy();
  });
});
