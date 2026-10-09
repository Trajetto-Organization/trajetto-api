import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import type { RouteOptions } from "fastify";
import type { ZodTypeAny } from "zod";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

import { ndjsonDocFor } from "@/routes/documentation/ndjson";

import { strictIssues } from "../unitaires/contract/support/deep-strict";

/**
 * The user listings never carry the password hash.
 *
 * The three of them stream NDJSON, and a stream does not go through the
 * response serializer — so the zod schema that lists a user's public fields
 * is never applied, and whatever the query selects is what leaves. Two of the
 * queries selected the whole row: every bcrypt hash of a company went to any
 * profile allowed to read its users (and every MASTER's to any MASTER), in
 * the browser, through the web's infinite scroll.
 */
const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const BUSINESS = "018fb000-0000-7000-8000-0000000005a1";
const HASH = "$2a$08$hash.que.nunca.pode.sair.da.api..................";

let adminToken = "";
let masterToken = "";

// The routes as registered, to read the line each one documents.
const registered = new Map<string, RouteOptions>();

function documentedLine(url: string): ZodTypeAny {
  const response = registered.get(url)?.schema?.response as
    | Record<string, unknown>
    | undefined;

  const doc = ndjsonDocFor(response?.[200]);

  if (!doc) throw new Error(`${url} não documenta uma lista NDJSON`);

  return doc.item;
}

async function seedUser(
  role: "BUSINESS_ADMIN" | "MASTER",
  businessId: string | null,
): Promise<string> {
  const id = randomUUID();
  const familyId = randomUUID();

  await prisma.user.create({
    data: {
      id,
      name: role === "MASTER" ? "Master" : "Gestora",
      email: `${id}@exemplo.com.br`,
      password: HASH,
      role,
      businessId,
    },
  });

  await prisma.refreshToken.create({
    data: {
      userId: id,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  return sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "30m" },
  );
}

async function lines(url: string, token: string) {
  const response = await app.inject({
    method: "GET",
    url,
    headers: { authorization: `Bearer ${token}` },
  });

  expect(response.statusCode, response.body.slice(0, 300)).toBe(200);
  expect(response.headers["content-type"]).toContain("application/x-ndjson");

  return response.body
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Sem Hash",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "33222444000555",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: "sem-hash@exemplo.com.br",
      vehicle_limit: 10,
    },
  });

  adminToken = await seedUser("BUSINESS_ADMIN", BUSINESS);
  await seedUser("BUSINESS_ADMIN", BUSINESS);

  masterToken = await seedUser("MASTER", null);
  await seedUser("MASTER", null);

  // A user with an access profile and a driver record, so the listing's
  // nested objects are on the wire and not just null.
  const profile = await prisma.profileAccess.create({
    data: { name: "Operação", businessId: BUSINESS },
  });

  const driver = await prisma.driver.create({
    data: {
      name: "Motorista Listado",
      birth_date: new Date("1990-01-01"),
      cnh: "cnh-sem-hash",
      cpf: "cpf-sem-hash",
      rg: "rg-sem-hash",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId: BUSINESS,
    },
  });

  await prisma.user.create({
    data: {
      name: "Motorista Listado",
      email: `${randomUUID()}@exemplo.com.br`,
      password: HASH,
      role: "BUSINESS_USER",
      businessId: BUSINESS,
      profileAccessId: profile.id,
      driverId: driver.id,
    },
  });

  ({ app } = await import("@/http"));

  // Before ready(): the route plugins register during boot.
  app.addHook("onRoute", (route) => {
    if (route.method === "GET") registered.set(route.url, route as RouteOptions);
  });

  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.$disconnect();
});

describe("a user listing", () => {
  it.each([
    ["the cursor search", () => `/user/search-user-business?businessId=${BUSINESS}`, () => adminToken],
    ["the paged list", () => "/user/list-user?page=1&pageSize=10", () => adminToken],
    ["the MASTER list", () => "/user/list-master-users?page=1&pageSize=10", () => masterToken],
  ])("%s streams users without the password hash", async (_name, url, token) => {
    const [meta, ...users] = await lines(url(), token());

    expect(meta.meta).toBeDefined();
    expect(users.length).toBeGreaterThan(0);

    for (const user of users) {
      expect(user.id).toBeTruthy();
      expect(Object.keys(user)).not.toContain("password");
    }

    expect(JSON.stringify(users)).not.toContain(HASH);
  });
});

describe("the line /docs promises for a user listing", () => {
  /**
   * No serializer stands between these queries and the client, so this is
   * the only allowlist the listings have: every key a line carries must be in
   * the document, and every field the document requires must be on the line.
   * A column added to User fails here until somebody documents it — which is
   * the moment to decide whether it may leave the API at all.
   */
  it.each([
    [
      "the cursor search",
      () => `/user/search-user-business?businessId=${BUSINESS}`,
      () => adminToken,
      "/user/search-user-business",
    ],
    [
      "the paged list",
      () => "/user/list-user?page=1&pageSize=10",
      () => adminToken,
      "/user/list-user",
    ],
    [
      "the paged list, as MASTER (with the company)",
      // The MASTER names the company: one company per list (decision 8.8).
      () => `/user/list-user?page=1&pageSize=10&businessId=${BUSINESS}`,
      () => masterToken,
      "/user/list-user",
    ],
    [
      "the MASTER list",
      () => "/user/list-master-users?page=1&pageSize=10",
      () => masterToken,
      "/user/list-master-users",
    ],
  ])("%s streams exactly the documented line", async (_name, url, token, path) => {
    const [, ...users] = await lines(url(), token());

    expect(users.length).toBeGreaterThan(0);

    const item = documentedLine(path);

    for (const user of users) {
      expect(strictIssues(item, user), String(user.id)).toEqual([]);
    }
  });
});
