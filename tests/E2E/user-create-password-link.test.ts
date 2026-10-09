import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { compare } from "bcrypt";
import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";

/**
 * A new account never gets its password by e-mail (decision 4.9,
 * SEC-MAIL-1): the welcome e-mail carries a single-use link to set it, for
 * a company user and for a master alike; a master resetting another master
 * sends a link too. Against Postgres, through the HTTP routes.
 */
const events = vi.hoisted(() => ({
  user: [] as Array<{ userId: string; reason: string }>,
}));

vi.mock("@/websocket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/websocket")>();

  return {
    ...actual,
    sendSecurityEventToUser: (userId: string, event: { reason: string }) => {
      events.user.push({ userId, reason: event.reason });
    },
  };
});

const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = randomUUID();

interface Mail {
  to: string;
  path: string;
  variables: Record<string, unknown>;
}

const mails: Mail[] = [];
const created: string[] = [];

interface Seeded {
  id: string;
  email: string;
  token: string;
}

async function seedUser(
  role: "MASTER" | "BUSINESS_ADMIN",
  businessId: string | null,
): Promise<Seeded> {
  const id = randomUUID();
  const familyId = randomUUID();
  const email = `${id}@exemplo.com.br`;

  await prisma.user.create({
    data: {
      id,
      name: role === "MASTER" ? "Master Semeada" : "Gestora Semeada",
      email,
      password: "$2a$08$hash.que.nao.importa.aqui.............................",
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

  created.push(id);

  return {
    id,
    email,
    token: sign({ tokenType: "access", sessionVersion: 0, familyId }, auth.secret_token, {
      subject: id,
      expiresIn: "30m",
    }),
  };
}

async function mailTo(email: string, template: string): Promise<Mail | undefined> {
  const deadline = Date.now() + 3_000;

  for (;;) {
    const found = mails.find((mail) => mail.to === email && mail.path.endsWith(template));

    if (found || Date.now() > deadline) return found;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function expectLinkWithoutPassword(mail: Mail | undefined, typed?: string) {
  expect(mail).toBeDefined();
  expect(String(mail!.variables.url)).toMatch(/\/forgot\/password\?token=[0-9a-f-]{36}$/);
  expect(Object.keys(mail!.variables).some((key) => /password|senha/i.test(key))).toBe(false);

  if (typed) expect(JSON.stringify(mail!.variables)).not.toContain(typed);
}

let admin: Seeded;
let master: Seeded;
let profile = "";

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: A,
      corporate_reason: "Transportadora do Link",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(52000000000100 + Math.floor(Math.random() * 1_000_000)),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${A}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });

  profile = (
    await prisma.profileAccess.create({ data: { name: "Operação", businessId: A } })
  ).id;

  admin = await seedUser("BUSINESS_ADMIN", A);
  master = await seedUser("MASTER", null);

  ({ app } = await import("@/http"));
  await app.ready();

  container.registerInstance("MailProvider", {
    sendMail: async (message: Mail) => {
      mails.push(message);
      return { messageId: `<${randomUUID()}@x>` };
    },
  });
}, 120_000);

beforeEach(() => {
  events.user.length = 0;
});

afterAll(async () => {
  await app?.close();
  await prisma.user.deleteMany({ where: { id: { in: created } } });
  await prisma.business.deleteMany({ where: { id: A } });
  await prisma.$disconnect();
});

describe("a company user created by an administrator", () => {
  it("gets a set-password link, and whatever password a client sends is ignored", async () => {
    const email = `nova-${randomUUID()}@exemplo.com.br`;

    const response = await app.inject({
      method: "POST",
      url: "/user/create-user",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: {
        email,
        name: "Pessoa Nova Cadastrada",
        password: "SenhaQueNaoVale1",
        role: "BUSINESS_USER",
        businessId: A,
        profileAccessId: profile,
        userType: "employee",
      },
    });

    expect(response.statusCode, response.body).toBe(201);

    const user = await prisma.user.findFirstOrThrow({ where: { email } });
    created.push(user.id);

    // Nobody knows the stored password, the creator included.
    expect(await compare("SenhaQueNaoVale1", user.password)).toBe(false);

    expectLinkWithoutPassword(
      await mailTo(email, "user-created-successfully.hbs"),
      "SenhaQueNaoVale1",
    );

    const token = await prisma.forgotPasswordVerificationToken.findUnique({ where: { email } });

    expect(token).not.toBeNull();
    // A welcome may be read days later: 72 hours, not the hour of a reset.
    expect(token!.expires.getTime()).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
  });
});

describe("a master", () => {
  it("created by another master gets a set-password link", async () => {
    const email = `master-${randomUUID()}@exemplo.com.br`;

    const response = await app.inject({
      method: "POST",
      url: "/user/create-master-user",
      headers: { authorization: `Bearer ${master.token}` },
      payload: { email, name: "Master Nova Cadastrada" },
    });

    expect(response.statusCode, response.body).toBe(201);

    const created_ = await prisma.user.findFirstOrThrow({ where: { email } });
    created.push(created_.id);

    expectLinkWithoutPassword(await mailTo(email, "user-created-successfully.hbs"));
  });

  it("reset by another master receives a link; the password stays until used", async () => {
    const target = await seedUser("MASTER", null);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    const response = await app.inject({
      method: "PATCH",
      url: `/user/update-master-user/${target.id}`,
      headers: { authorization: `Bearer ${master.token}` },
      payload: { sendPasswordSetupLink: true },
    });

    expect(response.statusCode, response.body).toBe(200);

    expectLinkWithoutPassword(await mailTo(target.email, "password-reset-by-admin.hbs"));

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    expect(after.password).toBe(before.password);
    expect(after.session_version).toBe(before.session_version);
    expect(events.user).toEqual([]);
  });

  it("renamed by another master is not logged out", async () => {
    const target = await seedUser("MASTER", null);

    const response = await app.inject({
      method: "PATCH",
      url: `/user/update-master-user/${target.id}`,
      headers: { authorization: `Bearer ${master.token}` },
      payload: { name: "Master Renomeada Agora", email: target.email },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(events.user).toEqual([]);

    const me = await app.inject({
      method: "GET",
      url: "/user/me",
      headers: { authorization: `Bearer ${target.token}` },
    });

    expect(me.statusCode).toBe(200);
  });

  it("cannot be created or reset by a company administrator", async () => {
    const target = await seedUser("MASTER", null);

    const reset = await app.inject({
      method: "PATCH",
      url: `/user/update-master-user/${target.id}`,
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { sendPasswordSetupLink: true },
    });

    expect(reset.statusCode).toBe(403);

    const create = await app.inject({
      method: "POST",
      url: "/user/create-master-user",
      headers: { authorization: `Bearer ${admin.token}` },
      payload: { email: `x-${randomUUID()}@exemplo.com.br`, name: "Master Indevida Aqui" },
    });

    expect(create.statusCode).toBe(403);
  });
});
