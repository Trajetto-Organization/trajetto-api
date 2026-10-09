import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { uploadConfig } from "@/config/upload";

/**
 * The orphan collector against a real Postgres and a real (local) bucket.
 *
 * Objects reach storage through presigned PUTs and become rows only when the
 * client submits. Everything that never became a row — abandoned forms,
 * refused heads, deletes that failed — stayed forever, and nothing counted
 * them. The collector counts them every night and, only when told to, removes
 * the ones 30 to 33 days old that no row references.
 *
 * What must never be removed is asserted as hard as what must: a referenced
 * object, a recent one, and one whose key does not carry its own timestamp.
 */
const prisma = new PrismaClient();

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const BUSINESS = "018fc000-0000-7000-8000-0000000009b1";
const SHIPPER = "018fc000-0000-7000-8000-0000000009c1";
const USER = "018fc000-0000-7000-8000-0000000009a1";

const OLD = NOW - 31 * DAY;

const key = {
  proofReferenced: `deliveryPhotos/${BUSINESS}/${OLD}-canhoto-aaaa0001.jpg`,
  signatureReferenced: `deliveryPhotos/${BUSINESS}/${OLD + 1}-assinatura-aaaa0002.png`,
  proofOrphan: `deliveryPhotos/${BUSINESS}/${OLD + 2}-abandonada-aaaa0003.jpg`,
  proofRecent: `deliveryPhotos/${BUSINESS}/${NOW - DAY}-recente-aaaa0004.jpg`,
  proofLegacy: `deliveryPhotos/${BUSINESS}/legado.jpg`,
  avatarReferenced: `avatars/${USER}/${OLD}-eu-bbbb0001.jpg`,
  avatarOrphan: `avatars/${USER}/${OLD + 5}-antigo-bbbb0002.jpg`,
};

let storageRoot = "";

const saved = {
  type: uploadConfig.storage.type,
  localPath: uploadConfig.storage.localPath,
};

function write(objectKey: string): void {
  const full = path.join(storageRoot, objectKey);

  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from("x"));
}

const exists = (objectKey: string) =>
  fs.existsSync(path.join(storageRoot, objectKey));

beforeAll(async () => {
  storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trajetto-orphan-gc-"));

  uploadConfig.storage.type = "local";
  uploadConfig.storage.localPath = storageRoot;

  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora dos Órfãos",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "22333444000188",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `orfaos-${randomUUID()}@exemplo.com.br`,
    },
  });

  await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa com Avatar",
      email: `avatar-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
      avatar: key.avatarReferenced,
    },
  });

  await prisma.shipper.create({
    data: { id: SHIPPER, name: "Embarcador", businessId: BUSINESS },
  });

  const delivery = await prisma.delivery.create({
    data: {
      businessId: BUSINESS,
      shipperId: SHIPPER,
      code: "PED-ORFAO",
      recipient_name: "Cliente",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      status: "DELIVERED",
    },
  });

  await prisma.deliveryEvent.create({
    data: {
      type: "PROOF",
      deliveryId: delivery.id,
      businessId: BUSINESS,
      photo: key.proofReferenced,
      signature: key.signatureReferenced,
    },
  });
}, 120_000);

beforeEach(() => {
  for (const objectKey of Object.values(key)) write(objectKey);

  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterAll(async () => {
  uploadConfig.storage.type = saved.type;
  uploadConfig.storage.localPath = saved.localPath;

  fs.rmSync(storageRoot, { recursive: true, force: true });

  await prisma.deliveryEvent.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.delivery.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.shipper.deleteMany({ where: { businessId: BUSINESS } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await prisma.$disconnect();
});

async function run(mode: "off" | "dry-run" | "delete") {
  const { runOrphanUploadGc } = await import(
    "@/shared/services/orphan-uploads"
  );

  return runOrphanUploadGc({ mode, now: NOW });
}

describe("the orphan collector", () => {
  it("in dry-run, counts the orphans and removes nothing", async () => {
    const summary = await run("dry-run");

    expect(summary).toMatchObject({ mode: "dry-run", orphaned: 2, deleted: 0 });

    for (const objectKey of Object.values(key)) {
      expect(exists(objectKey), objectKey).toBe(true);
    }
  });

  it("in delete mode, removes only unreferenced objects 30 to 33 days old", async () => {
    const summary = await run("delete");

    expect(summary).toMatchObject({
      mode: "delete",
      orphaned: 2,
      deleted: 2,
      failed: 0,
    });

    expect(exists(key.proofOrphan)).toBe(false);
    expect(exists(key.avatarOrphan)).toBe(false);

    // Referenced by a row, too young, or not in the presigned key format.
    expect(exists(key.proofReferenced)).toBe(true);
    expect(exists(key.signatureReferenced)).toBe(true);
    expect(exists(key.proofRecent)).toBe(true);
    expect(exists(key.proofLegacy)).toBe(true);
    expect(exists(key.avatarReferenced)).toBe(true);
  });

  it("switched off, does nothing at all", async () => {
    const summary = await run("off");

    expect(summary).toBeNull();
    expect(exists(key.proofOrphan)).toBe(true);
  });
});

describe("the reference queries", () => {
  it("run for every namespace against the real schema", async () => {
    const { ORPHAN_GC_NAMESPACES, orphanWindow, keyRange } = await import(
      "@/shared/services/orphan-uploads"
    );

    const window = orphanWindow(NOW);

    for (const [type, namespace] of Object.entries(ORPHAN_GC_NAMESPACES)) {
      const prefix = `${type}/${namespace.scope === "user" ? USER : BUSINESS}/`;

      await expect(
        namespace.referenced({
          scopeId: namespace.scope === "user" ? USER : BUSINESS,
          keys: [`${prefix}${OLD}-x-00000000.jpg`],
          ...keyRange(prefix, window),
          since: new Date(window.startMs - DAY),
        }),
        type,
      ).resolves.toBeInstanceOf(Set);
    }
  });

  it("finds a checklist photo at any depth of photos_by_field", async () => {
    // The mapping is `{ field: [path, …] }` today; the query walks every
    // string in it, so a reshaped mapping cannot make a live photo an orphan.
    const rows = await prisma.$queryRaw<Array<{ key: string }>>`
      SELECT s #>> '{}' AS key
      FROM jsonb_path_query(
        '{"pneus": ["a.jpg", "b.jpg"], "painel": "c.jpg", "x": {"y": ["d.jpg"]}}'::jsonb,
        'strict $.** ? (@.type() == "string")'
      ) AS s
    `;

    expect(rows.map((row) => row.key).sort()).toEqual([
      "a.jpg",
      "b.jpg",
      "c.jpg",
      "d.jpg",
    ]);
  });
});
