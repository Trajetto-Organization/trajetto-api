import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { uploadConfig } from "@/config/upload";

import { seedFleetDriver } from "./support/fleet-driver-seed";
import { clearLogged, logged } from "../support/log-capture";

vi.mock("@/shared/logging/logger", async (importOriginal) =>
  (await import("../support/log-capture")).capturingLogger(
    await importOriginal(),
  ),
);

/**
 * The orphan collector's reference lookups, each one proven to FIND a key.
 *
 * In delete mode every object in the window that a lookup does not return is
 * removed. So a lookup that runs but matches nothing — a wrong column, a
 * JSON shape it does not walk, a comparison that never holds — does not fail
 * loudly: it turns every live photo in its namespace into an "orphan". Only
 * a test that seeds a real row and expects its key back can tell a working
 * lookup from a silent one; "the query returns a Set" cannot.
 *
 * And one scope that fails (a storage listing, a query) must cost that scope
 * only: the nightly summary is what the decision to switch deleting on is
 * based on, and a run that rejects on the first hiccup never logs it.
 */
const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = NOW - 31 * DAY;

const BUSINESS = "018fc000-0000-7000-8000-000000000ab1";

const key = {
  fuel: `odometerPhotos/${BUSINESS}/${OLD}-odometro-cccc0001.jpg`,
  fuelOrphan: `odometerPhotos/${BUSINESS}/${OLD + 1}-solta-cccc0002.jpg`,

  checklistFlat: `checklistPhotos/${BUSINESS}/${OLD}-pneu-dddd0001.jpg`,
  // Only in photos_by_field, not in the flat list.
  checklistFieldOnly: `checklistPhotos/${BUSINESS}/${OLD + 1}-painel-dddd0002.jpg`,
  checklistOrphan: `checklistPhotos/${BUSINESS}/${OLD + 2}-solta-dddd0003.jpg`,

  occurrence: `deliveryPhotos/${BUSINESS}/${OLD}-ocorrencia-eeee0001.jpg`,
  // Decision 14.3: held ONLY by an occurrence (a pending delivery request).
  occurrenceReceipt: `deliveryPhotos/${BUSINESS}/${OLD + 2}-canhoto-eeee0003.jpg`,
  occurrenceSignature: `deliveryPhotos/${BUSINESS}/${OLD + 3}-assinatura-eeee0004.png`,
  deliveryOrphan: `deliveryPhotos/${BUSINESS}/${OLD + 1}-solta-eeee0002.jpg`,

  chatPhoto: `chatAttachments/${BUSINESS}/${OLD}-foto-ffff0001.jpg`,
  chatVoice: `chatAttachments/${BUSINESS}/${OLD + 1}-nota-ffff0002.m4a`,
  chatOrphan: `chatAttachments/${BUSINESS}/${OLD + 2}-solta-ffff0003.jpg`,
};

const referenced = [
  key.fuel,
  key.checklistFlat,
  key.checklistFieldOnly,
  key.occurrence,
  key.occurrenceReceipt,
  key.occurrenceSignature,
  key.chatPhoto,
  key.chatVoice,
];

let storageRoot = "";

const saved = {
  type: uploadConfig.storage.type,
  localPath: uploadConfig.storage.localPath,
};

const exists = (objectKey: string) =>
  fs.existsSync(path.join(storageRoot, objectKey));

beforeAll(async () => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajetto-orphan-refs-"));

  uploadConfig.storage.type = "local";
  uploadConfig.storage.localPath = storageRoot;

  const fleet = await seedFleetDriver(prisma, {
    businessId: BUSINESS,
    cnpj: "33444555000177",
  });

  await prisma.fuel.create({
    data: {
      businessId: BUSINESS,
      branchId: fleet.branchId,
      vehicleId: fleet.vehicleId,
      driverId: fleet.driverId,
      fuelTypeId: fleet.fuelTypeId,
      current_mileage: 1_100,
      liters_amount: 100,
      price_per_liter: 6,
      total_amount: 600,
      odometer_photo: key.fuel,
    },
  });

  await prisma.vehicleChecklist.create({
    data: {
      businessId: BUSINESS,
      branchId: fleet.branchId,
      vehicleId: fleet.vehicleId,
      driverId: fleet.driverId,
      current_mileage: 1_100,
      tires_condition: "good",
      bumpers_condition: "good",
      windshield_condition: "good",
      mirrors_condition: "good",
      steering_wheel_condition: "good",
      battery_condition: "good",
      spare_tire_condition: "good",
      overall_condition: "approved",
      photos: [key.checklistFlat],
      photos_by_field: {
        tires_condition: [key.checklistFlat],
        dashboard: [key.checklistFieldOnly],
      },
    },
  });

  const shipper = await prisma.shipper.create({
    data: { name: "Embarcador", businessId: BUSINESS },
  });

  const occurrenceType = await prisma.occurrenceType.create({
    data: {
      name: "Cliente ausente",
      blocks_delivery: false,
      businessId: BUSINESS,
    },
  });

  const delivery = await prisma.delivery.create({
    data: {
      businessId: BUSINESS,
      shipperId: shipper.id,
      code: "PED-REFS",
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "IN_TRANSIT",
      driverId: fleet.driverId,
    },
  });

  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId: delivery.id,
      businessId: BUSINESS,
      occurrenceTypeId: occurrenceType.id,
      reportedById: fleet.driverUserId,
      photos: [key.occurrence],
    },
  });

  // A delivery request still waiting for the tower: no PROOF event exists,
  // so the occurrence is the only row that names the receipt and signature.
  const deliveredType = await prisma.occurrenceType.create({
    data: {
      name: "Entrega com conferência",
      category: "DELIVERED",
      requires_receipt_photo: true,
      requires_authorization: true,
      businessId: BUSINESS,
    },
  });

  await prisma.deliveryOccurrence.create({
    data: {
      deliveryId: delivery.id,
      businessId: BUSINESS,
      occurrenceTypeId: deliveredType.id,
      reportedById: fleet.driverUserId,
      category: "DELIVERED",
      authorization_status: "PENDING",
      receipt_photo: key.occurrenceReceipt,
      signature: key.occurrenceSignature,
    },
  });

  const thread = await prisma.chatThread.create({
    data: { businessId: BUSINESS, driverId: fleet.driverId },
  });

  await prisma.chatMessage.createMany({
    data: [
      {
        kind: "IMAGE",
        attachment_key: key.chatPhoto,
        threadId: thread.id,
        senderId: fleet.driverUserId,
      },
      {
        kind: "AUDIO",
        attachment_key: key.chatVoice,
        duration_ms: 3_000,
        threadId: thread.id,
        senderId: fleet.driverUserId,
      },
    ],
  });
}, 120_000);

beforeEach(() => {
  for (const objectKey of Object.values(key)) {
    const full = path.join(storageRoot, objectKey);

    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, Buffer.from("x"));
  }
});

afterAll(async () => {
  uploadConfig.storage.type = saved.type;
  uploadConfig.storage.localPath = saved.localPath;

  fs.rmSync(storageRoot, { recursive: true, force: true });

  await prisma.$disconnect();
});

async function load() {
  return import("@/shared/services/orphan-uploads");
}

describe("each reference lookup", () => {
  it.each([
    ["odometerPhotos", [key.fuel], [key.fuelOrphan]],
    [
      "checklistPhotos",
      [key.checklistFlat, key.checklistFieldOnly],
      [key.checklistOrphan],
    ],
    [
      "deliveryPhotos",
      [key.occurrence, key.occurrenceReceipt, key.occurrenceSignature],
      [key.deliveryOrphan],
    ],
    ["chatAttachments", [key.chatPhoto, key.chatVoice], [key.chatOrphan]],
  ] as const)(
    "%s: finds the keys a row holds, and only those",
    async (type, live, orphans) => {
      const { ORPHAN_GC_NAMESPACES, keyRange, orphanWindow } = await load();

      const window = orphanWindow(NOW);
      const prefix = `${type}/${BUSINESS}/`;

      const found = await ORPHAN_GC_NAMESPACES[type].referenced({
        scopeId: BUSINESS,
        keys: [...live, ...orphans],
        ...keyRange(prefix, window),
        since: new Date(window.startMs - DAY),
      });

      expect([...found].sort()).toEqual([...live].sort());
    },
  );
});

describe("a delete run over live rows", () => {
  it("keeps every referenced object and removes only the orphans", async () => {
    const { runOrphanUploadGc } = await load();

    const summary = await runOrphanUploadGc({ mode: "delete", now: NOW });

    expect(summary).toMatchObject({ orphaned: 4, deleted: 4, failed: 0 });

    for (const objectKey of referenced) {
      expect(exists(objectKey), objectKey).toBe(true);
    }

    for (const objectKey of [
      key.fuelOrphan,
      key.checklistOrphan,
      key.deliveryOrphan,
      key.chatOrphan,
    ]) {
      expect(exists(objectKey), objectKey).toBe(false);
    }
  });

  it("survives a scope that fails: the rest is collected and the summary still comes back", async () => {
    const { runOrphanUploadGc } = await load();
    const { UploadService } = await import("@/shared/services/upload-service");

    const real = new UploadService();

    // The chat listing fails (a storage error that outlived the SDK's own
    // retries); every other scope answers normally.
    const flaky = {
      listObjectKeys: (
        prefix: string,
        startAfter?: string,
        maxKeys?: number,
      ) =>
        prefix.startsWith("chatAttachments/")
          ? Promise.reject(new Error("ListObjectsV2: 503 SlowDown"))
          : real.listObjectKeys(prefix, startAfter, maxKeys),
      tryDeleteFile: (objectKey: string) => real.tryDeleteFile(objectKey),
    };

    clearLogged();

    const summary = await runOrphanUploadGc({
      mode: "delete",
      now: NOW,
      uploadService: flaky,
    });

    expect(summary).toMatchObject({ errors: 1, deleted: 3, failed: 0 });

    // Nothing in the failed scope was touched, live or not.
    expect(exists(key.chatOrphan)).toBe(true);
    expect(exists(key.chatPhoto)).toBe(true);

    // The scopes that answered were collected as usual.
    expect(exists(key.fuelOrphan)).toBe(false);
    expect(exists(key.fuel)).toBe(true);

    // Named, so somebody can tell which scope keeps failing.
    expect(logged("error")).toContainEqual(
      expect.objectContaining({
        scope: expect.stringContaining(`chatAttachments/${BUSINESS}/`),
        err: expect.objectContaining({
          message: expect.stringContaining("SlowDown"),
        }),
      }),
    );
  });
});
