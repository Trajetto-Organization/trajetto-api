import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

import { sign } from "jsonwebtoken";
import { container } from "tsyringe";

import auth from "@/config/auth";
import type { IUsersTokensRepository } from "@/modules/user/repositories/IUsers-tokens-repository";

/**
 * Editing a user, against Postgres (decisions 4.6 and 4.9, USR-EDIT-1/2/3,
 * NOTIF-ROLE-1, SEC-MAIL-1).
 *
 * - A rename, or any edit that sends the same values back, logs nobody out:
 *   the web sends the whole form on every save and the API used to read the
 *   mere presence of `email` as a security change. A `businessId` is now
 *   refused outright: no edit moves a person between companies (decision
 *   16.100, record-company-move-blocked.test.ts).
 * - A change of role or driver link ends the sessions in the same
 *   transaction (session_version, refresh tokens, push devices) and empties
 *   the inbox; activities stay.
 * - A MASTER resets a password by link. No password travels by e-mail.
 */
const events = vi.hoisted(() => ({
  user: [] as Array<{ userId: string; reason: string }>,
}));

vi.mock("@/websocket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/websocket")>();

  return {
    ...actual,
    // What the use case decides to tell the person's sockets is the thing
    // under test; there is no socket server in this process to deliver it.
    sendSecurityEventToUser: (userId: string, event: { reason: string }) => {
      events.user.push({ userId, reason: event.reason });
    },
    refreshDeliveryRooms: async () => undefined,
  };
});

const prisma = new PrismaClient();

let app: Awaited<typeof import("@/http")>["app"];

const A = randomUUID();
const B = randomUUID();

const HASH = "$2a$08$hash.da.senha.atual.que.nao.pode.mudar.aqui...........";

interface Mail {
  to: string;
  path: string;
  variables: Record<string, unknown>;
}

const mails: Mail[] = [];

let cnpj = 51000000000100;

async function seedBusiness(id: string): Promise<void> {
  cnpj += 1;

  await prisma.business.create({
    data: {
      id,
      corporate_reason: `Transportadora ${id.slice(0, 4)}`,
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: String(cnpj),
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `${id}@exemplo.com.br`,
      vehicle_limit: 10,
    },
  });
}

interface Seeded {
  id: string;
  email: string;
  token: string;
}

async function seedUser(data: {
  role: "MASTER" | "BUSINESS_ADMIN" | "BUSINESS_USER";
  businessId: string | null;
  profileAccessId?: string | null;
  driverId?: string | null;
  name?: string;
}): Promise<Seeded> {
  const id = randomUUID();
  const familyId = randomUUID();
  const email = `${id}@exemplo.com.br`;

  await prisma.user.create({
    data: {
      id,
      name: data.name ?? "Pessoa Cadastrada",
      email,
      password: HASH,
      role: data.role,
      businessId: data.businessId,
      profileAccessId: data.profileAccessId ?? null,
      driverId: data.driverId ?? null,
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

  const token = sign(
    { tokenType: "access", sessionVersion: 0, familyId },
    auth.secret_token,
    { subject: id, expiresIn: "30m" },
  );

  return { id, email, token };
}

async function seedProfile(
  businessId: string,
  name: string,
  grants: Array<{ key: string; read: boolean; write: boolean }> = [],
): Promise<string> {
  const profile = await prisma.profileAccess.create({
    data: { name, businessId },
  });

  for (const grant of grants) {
    await prisma.permission.create({
      data: {
        action: grant.key,
        permissionKey: grant.key,
        canRead: grant.read,
        canWrite: grant.write,
        businessId,
        profileAccessId: profile.id,
      },
    });
  }

  return profile.id;
}

async function seedDriver(businessId: string, name: string): Promise<string> {
  const suffix = randomUUID().replace(/\D/g, "").slice(0, 9).padEnd(9, "0");

  const driver = await prisma.driver.create({
    data: {
      name,
      birth_date: new Date("1990-01-01T03:00:00.000Z"),
      cnh: `9${suffix}0`,
      cpf: `8${suffix}0`,
      rg: "123456789",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      status: "ACTIVE",
      contract_type: "OWNED",
      businessId,
    },
  });

  return driver.id;
}

/** The inbox, the push devices and an activity, so the purge has something to do. */
async function seedBelongings(userId: string, businessId: string): Promise<void> {
  await prisma.notification.createMany({
    data: [
      { type: "delivery", title: "Sua entrega", message: "Rota do dia", userId, businessId, link: "/driver/deliveries" },
      { type: "plan", title: "Plano", message: "Limite", userId, businessId },
    ],
  });

  await prisma.pushDeviceToken.create({
    data: { userId, token: `ExponentPushToken[${randomUUID()}]`, platform: "android" },
  });

  await prisma.activity.create({
    data: {
      type: "Usuário",
      action: "update",
      entityId: userId,
      description: "Ação antiga do usuário",
      status: "Atualizado",
      businessId,
      performedBy: userId,
    },
  });
}

async function belongings(userId: string) {
  const [user, refresh, push, notifications, activities] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    prisma.refreshToken.count({ where: { userId } }),
    prisma.pushDeviceToken.count({ where: { userId } }),
    prisma.notification.count({ where: { userId } }),
    prisma.activity.count({ where: { performedBy: userId } }),
  ]);

  return { user, refresh, push, notifications, activities };
}

async function patch(actor: Seeded, target: string, payload: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: `/user/update-user/${target}`,
    headers: { authorization: `Bearer ${actor.token}` },
    payload,
  });
}

async function me(user: Seeded) {
  return app.inject({
    method: "GET",
    url: "/user/me",
    headers: { authorization: `Bearer ${user.token}` },
  });
}

async function mailsTo(email: string, template: string, wait = 2_000): Promise<Mail[]> {
  const deadline = Date.now() + wait;

  for (;;) {
    const found = mails.filter((mail) => mail.to === email && mail.path.endsWith(template));

    if (found.length > 0 || Date.now() > deadline) return found;

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

let admin: Seeded;
let master: Seeded;
let profileA1 = "";
let profileA2 = "";
let profileB1 = "";

beforeAll(async () => {
  await seedBusiness(A);
  await seedBusiness(B);

  // A profile with no permission at all is not a session (AUTH_PROFILE_NOT_CONFIGURED).
  const kanban = [{ key: "kanban_manage", read: true, write: false }];

  profileA1 = await seedProfile(A, "Operação A", kanban);
  profileA2 = await seedProfile(A, "Financeiro A", kanban);
  profileB1 = await seedProfile(B, "Operação B", kanban);

  admin = await seedUser({ role: "BUSINESS_ADMIN", businessId: A, name: "Gestora da Empresa" });
  master = await seedUser({ role: "MASTER", businessId: null, name: "Master da Plataforma" });

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
  await prisma.business.deleteMany({ where: { id: { in: [A, B] } } });
  await prisma.user.deleteMany({ where: { id: master.id } });
  await prisma.$disconnect();
});

describe("an edit that changes nothing sensitive (USR-EDIT-1)", () => {
  it("renaming, with the whole form sent back, keeps the person logged in", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });
    await seedBelongings(target.id, A);

    const response = await patch(admin, target.id, {
      name: "Nome Novo Completo",
      email: target.email,
      role: "BUSINESS_USER",
      profileAccessId: profileA1,
      driverId: "",
      userType: "employee",
    });

    expect(response.statusCode, response.body).toBe(200);

    const after = await belongings(target.id);

    expect(after.user.name).toBe("Nome Novo Completo");
    expect(after.user.session_version).toBe(0);
    expect(after.refresh).toBe(1);
    expect(after.push).toBe(1);
    expect(after.notifications).toBe(2);

    // No kick over the socket either: that is what logged people out.
    expect(events.user).toEqual([]);
    expect((await me(target)).statusCode).toBe(200);
  });

  it("sending exactly the stored values writes nothing and audits nothing", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
    const audits = () => prisma.activity.count({ where: { entityId: target.id } });
    const auditsBefore = await audits();

    const response = await patch(admin, target.id, {
      name: before.name,
      email: before.email,
      role: "BUSINESS_USER",
      profileAccessId: profileA1,
      driverId: "",
      userType: "employee",
    });

    expect(response.statusCode, response.body).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    // The early return: no UPDATE (updated_at untouched), no audit entry,
    // no socket event, the session intact.
    expect(after.updated_at.getTime()).toBe(before.updated_at.getTime());
    expect(await audits()).toBe(auditsBefore);
    expect(events.user).toEqual([]);
    expect(after.session_version).toBe(0);
  });

  it("an e-mail sent back in another case is written, but is not a session change", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });
    const before = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    const response = await patch(admin, target.id, {
      name: before.name,
      email: before.email.toUpperCase(),
      role: "BUSINESS_USER",
      profileAccessId: profileA1,
    });

    expect(response.statusCode, response.body).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    expect(after.email).toBe(before.email.toUpperCase());
    expect(after.session_version).toBe(0);
    expect(events.user.every((event) => event.reason !== "role_changed")).toBe(true);
  });

  it("changing only the profile keeps the session and asks the client to re-read", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });
    await seedBelongings(target.id, A);

    const response = await patch(admin, target.id, {
      name: "Pessoa Cadastrada",
      email: target.email,
      role: "BUSINESS_USER",
      profileAccessId: profileA2,
    });

    expect(response.statusCode, response.body).toBe(200);

    const after = await belongings(target.id);

    expect(after.user.profileAccessId).toBe(profileA2);
    expect(after.user.session_version).toBe(0);
    expect(after.refresh).toBe(1);
    expect(after.notifications).toBe(2);
    expect(events.user).toEqual([{ userId: target.id, reason: "permissions_changed" }]);
    expect((await me(target)).statusCode).toBe(200);
  });
});

describe("a change of role or driver link (USR-EDIT-2, NOTIF-ROLE-1)", () => {
  it("a new role ends every session and empties the inbox, keeping the activities", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });
    await seedBelongings(target.id, A);

    expect((await me(target)).statusCode).toBe(200);

    const response = await patch(admin, target.id, {
      name: "Pessoa Cadastrada",
      email: target.email,
      role: "BUSINESS_ADMIN",
    });

    expect(response.statusCode, response.body).toBe(200);

    const after = await belongings(target.id);

    expect(after.user.role).toBe("BUSINESS_ADMIN");
    expect(after.user.profileAccessId).toBeNull();
    expect(after.user.session_version).toBe(1);
    expect(after.refresh).toBe(0);
    expect(after.push).toBe(0);
    expect(after.notifications).toBe(0);
    expect(after.activities).toBeGreaterThanOrEqual(1);

    expect(events.user).toEqual([{ userId: target.id, reason: "role_changed" }]);

    // The token issued under the old role is dead: new login required.
    expect((await me(target)).statusCode).toBe(401);
  });

  // Decision 16.100: the MASTER used to move people this way. Nobody does now.
  it("the MASTER cannot move someone to another company, and nothing ends", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });
    await seedBelongings(target.id, A);

    const response = await patch(master, target.id, {
      name: "Pessoa Cadastrada",
      email: target.email,
      role: "BUSINESS_USER",
      businessId: B,
      profileAccessId: profileB1,
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(JSON.parse(response.body).code).toBe("VALIDATION_ERROR");

    const after = await belongings(target.id);

    expect(after.user.businessId).toBe(A);
    expect(after.user.session_version).toBe(0);
    expect(after.refresh).toBe(1);
    expect(after.notifications).toBe(2);
    expect(events.user).toEqual([]);
    expect((await me(target)).statusCode).toBe(200);
  });

  it("what was fanned out and not delivered yet goes too on a role change; the ledger stays", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });

    // An event fanned out to the person under the old role. availableAt in
    // the future: the running pipeline must not claim it before the change —
    // the point is what the change does to it.
    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `user-move:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: A,
        status: "PUBLISHED",
        payload: { businessId: A },
      },
    });

    const later = new Date(Date.now() + 60 * 60 * 1000);

    await prisma.notificationDelivery.createMany({
      data: [
        { outboxEventId: event.id, userId: target.id, channel: "IN_APP", status: "PENDING", availableAt: later },
        { outboxEventId: event.id, userId: target.id, channel: "EMAIL", status: "PROCESSING", availableAt: later, leaseExpiresAt: later, attempts: 1 },
        { outboxEventId: event.id, userId: target.id, channel: "PUSH", status: "DELIVERED", deliveredAt: new Date(), attempts: 1 },
      ],
    });

    const response = await patch(admin, target.id, { role: "BUSINESS_ADMIN" });

    expect(response.statusCode, response.body).toBe(200);

    const left = await prisma.notificationDelivery.findMany({
      where: { userId: target.id },
      select: { channel: true, status: true },
    });

    // Nothing addressed to the old role can still land in the inbox (or the
    // mailbox) of someone who now holds another one.
    expect(left).toEqual([{ channel: "PUSH", status: "DELIVERED" }]);
  });

  it("a profile change alone keeps what is on its way", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });

    const event = await prisma.domainOutboxEvent.create({
      data: {
        eventKey: `user-profile:${randomUUID()}`,
        topic: "account-payable.created",
        aggregateType: "account-payable",
        aggregateId: randomUUID(),
        businessId: A,
        status: "PUBLISHED",
        payload: { businessId: A },
      },
    });

    await prisma.notificationDelivery.create({
      data: {
        outboxEventId: event.id,
        userId: target.id,
        channel: "IN_APP",
        status: "PENDING",
        availableAt: new Date(Date.now() + 60 * 60 * 1000),
      },
    });

    const response = await patch(admin, target.id, { profileAccessId: profileA2 });

    expect(response.statusCode, response.body).toBe(200);
    expect(await prisma.notificationDelivery.count({ where: { userId: target.id } })).toBe(1);
  });

  it("linking another driver ends the sessions of the login", async () => {
    const first = await seedDriver(A, "Motorista Um");
    const second = await seedDriver(A, "Motorista Dois");
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, driverId: first });
    await seedBelongings(target.id, A);

    const response = await patch(admin, target.id, {
      role: "BUSINESS_USER",
      driverId: second,
      profileAccessId: "",
      userType: "driver",
    });

    expect(response.statusCode, response.body).toBe(200);

    const after = await belongings(target.id);

    expect(after.user.driverId).toBe(second);
    expect(after.user.session_version).toBe(1);
    expect(after.notifications).toBe(0);
    expect(events.user).toEqual([{ userId: target.id, reason: "role_changed" }]);
  });

  it("a profile alone replaces the driver link instead of keeping both (USR-EDIT-3)", async () => {
    const driver = await seedDriver(A, "Motorista Três");
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, driverId: driver });

    const response = await patch(admin, target.id, { profileAccessId: profileA1 });

    expect(response.statusCode, response.body).toBe(200);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    expect(after.profileAccessId).toBe(profileA1);
    expect(after.driverId).toBeNull();
    // Leaving the driver login is a change of link: the sessions end.
    expect(after.session_version).toBe(1);
  });
});

describe("who may edit whom", () => {
  it("a user with the write permission cannot demote an administrator", async () => {
    const editorProfile = await seedProfile(A, "Cadastros", [
      { key: "user_registration_manage", read: true, write: true },
    ]);
    const editor = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: editorProfile });
    const targetAdmin = await seedUser({ role: "BUSINESS_ADMIN", businessId: A });

    const response = await patch(editor, targetAdmin.id, {
      role: "BUSINESS_USER",
      profileAccessId: profileA1,
    });

    expect(response.statusCode).toBe(403);
    // The refusal a client reads as "sem permissão" (decision 4.1).
    expect(JSON.parse(response.body).code).toBe("PERMISSION_DENIED");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: targetAdmin.id } })).role).toBe(
      "BUSINESS_ADMIN",
    );
  });

  it("nor delete one, and the refusal says it is a permission", async () => {
    const editorProfile = await seedProfile(A, "Cadastros Exclusão", [
      { key: "user_registration_manage", read: true, write: true },
    ]);
    const editor = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: editorProfile });
    const targetAdmin = await seedUser({ role: "BUSINESS_ADMIN", businessId: A });

    const response = await app.inject({
      method: "DELETE",
      url: `/user/delete-user/${targetAdmin.id}`,
      headers: { authorization: `Bearer ${editor.token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(JSON.parse(response.body)).toMatchObject({
      code: "PERMISSION_DENIED",
      message:
        'Usuários com o nível de acesso "Usuário" não podem deletar usuários com o nível de acesso Administrador.',
    });
    expect(await prisma.user.count({ where: { id: targetAdmin.id } })).toBe(1);
  });

  it("an administrator of another company cannot edit this one's users", async () => {
    const otherAdmin = await seedUser({ role: "BUSINESS_ADMIN", businessId: B });
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });

    const response = await patch(otherAdmin, target.id, { name: "Nome Sequestrado Aqui" });

    // The same answer as an id that does not exist: 403 confirmed the user
    // is real in some other company (IDOR sweep, 10/2026).
    expect(response.statusCode).toBe(404);
    expect(response.json().code).toBe("USER_NOT_FOUND");
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).name).toBe(
      "Pessoa Cadastrada",
    );
  });

  it("a master who left a record behind is kept, as a conflict (409), not a 500", async () => {
    const other = await seedUser({ role: "MASTER", businessId: null, name: "Master Com Registro" });

    try {
      // An upload is a record of something a person did (RESTRICT FK).
      await prisma.import.create({
        data: {
          source: "SPREADSHEET",
          filename: "entregas.xlsx",
          report: [],
          businessId: A,
          performedById: other.id,
        },
      });

      const refused = await app.inject({
        method: "DELETE",
        url: `/user/delete-master-user/${other.id}`,
        headers: { authorization: `Bearer ${master.token}` },
      });

      expect(refused.statusCode, refused.body).toBe(409);
      expect(JSON.parse(refused.body).code).toBe("USER_HAS_RECORDS");
      expect(await prisma.user.count({ where: { id: other.id } })).toBe(1);
    } finally {
      await prisma.import.deleteMany({ where: { performedById: other.id } });
      await prisma.user.deleteMany({ where: { id: other.id } });
    }
  });

  it("a master is neither edited nor deleted through the company-user routes", async () => {
    const other = await seedUser({ role: "MASTER", businessId: null, name: "Outro Master Aqui" });

    try {
      // update-user would skip the master notices: refused for a master target.
      const updated = await patch(master, other.id, { name: "Master Renomeado" });

      expect(updated.statusCode).toBe(403);
      expect(JSON.parse(updated.body).code).toBe("PERMISSION_DENIED");

      // delete-user does not keep the last master: only delete-master-user does.
      const deleted = await app.inject({
        method: "DELETE",
        url: `/user/delete-user/${other.id}`,
        headers: { authorization: `Bearer ${master.token}` },
      });

      expect(deleted.statusCode).toBe(403);
      expect(JSON.parse(deleted.body).code).toBe("PERMISSION_DENIED");

      const row = await prisma.user.findUniqueOrThrow({ where: { id: other.id } });
      expect(row).toMatchObject({ name: "Outro Master Aqui", businessId: null, role: "MASTER" });
    } finally {
      await prisma.user.deleteMany({ where: { id: other.id } });
    }
  });
});

describe("a password reset by the MASTER (SEC-MAIL-1, decision 4.9)", () => {
  it("mails a single-use link, never a password, and leaves the current one in place", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });

    const response = await patch(master, target.id, {
      sendPasswordSetupLink: true,
      // A client still sending a password gets it ignored, never mailed.
      password: "SenhaDigitada123",
    });

    expect(response.statusCode, response.body).toBe(200);

    const [mail] = await mailsTo(target.email, "password-reset-by-admin.hbs");

    expect(mail).toBeDefined();
    expect(String(mail.variables.url)).toMatch(/\/forgot\/password\?token=[0-9a-f-]{36}$/);
    expect(JSON.stringify(mail.variables)).not.toContain("SenhaDigitada123");
    expect(Object.keys(mail.variables).some((key) => /password|senha/i.test(key))).toBe(false);

    const token = await prisma.forgotPasswordVerificationToken.findUnique({
      where: { email: target.email },
    });

    expect(token).not.toBeNull();
    expect(token!.expires.getTime()).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000);

    const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });

    expect(after.password).toBe(HASH);
    expect(after.session_version).toBe(0);

    // The link works on the reset endpoint the product already has.
    const raw = String(mail.variables.url).split("token=")[1];
    const reset = await app.inject({
      method: "POST",
      url: `/user/reset/password?token=${raw}`,
      payload: { password: "NovaSenha#2026", confirmPassword: "NovaSenha#2026" },
    });

    expect(reset.statusCode, reset.body).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: target.id } })).password).not.toBe(HASH);
  });

  describe("when the link cannot be stored", () => {
    let original: IUsersTokensRepository;

    beforeEach(() => {
      original = container.resolve<IUsersTokensRepository>("UsersTokensRepository");

      // The real repository, with the one write the link needs failing.
      const failing = new Proxy(original, {
        get(targetRepo, property, receiver) {
          if (property === "createForgotPasswordVerificationToken") {
            return async () => {
              throw new Error("tokens store unavailable");
            };
          }

          return Reflect.get(targetRepo, property, receiver);
        },
      });

      container.registerInstance("UsersTokensRepository", failing);
    });

    afterEach(() => {
      container.registerInstance("UsersTokensRepository", original);
    });

    it("says so, and changes nothing, instead of answering success", async () => {
      const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });

      const response = await patch(master, target.id, {
        name: "Nome Que Não Fica",
        sendPasswordSetupLink: true,
      });

      expect(response.statusCode).toBe(503);
      expect(JSON.parse(response.body).code).toBe("PASSWORD_LINK_UNAVAILABLE");

      // Failed whole: the rename did not commit either, so a retry is safe.
      const after = await prisma.user.findUniqueOrThrow({ where: { id: target.id } });
      expect(after.name).toBe("Pessoa Cadastrada");
      expect(await mailsTo(target.email, "password-reset-by-admin.hbs", 300)).toEqual([]);
    });

    it("does the same on the master route", async () => {
      const other = await seedUser({ role: "MASTER", businessId: null, name: "Master Sem Link" });

      try {
        const response = await app.inject({
          method: "PATCH",
          url: `/user/update-master-user/${other.id}`,
          headers: { authorization: `Bearer ${master.token}` },
          payload: { name: "Master Renomeado Agora", sendPasswordSetupLink: true },
        });

        expect(response.statusCode).toBe(503);
        expect(JSON.parse(response.body).code).toBe("PASSWORD_LINK_UNAVAILABLE");
        expect((await prisma.user.findUniqueOrThrow({ where: { id: other.id } })).name).toBe(
          "Master Sem Link",
        );
      } finally {
        await prisma.user.deleteMany({ where: { id: other.id } });
      }
    });
  });

  it("is refused to anyone but the MASTER", async () => {
    const target = await seedUser({ role: "BUSINESS_USER", businessId: A, profileAccessId: profileA1 });

    const response = await patch(admin, target.id, { sendPasswordSetupLink: true });

    expect(response.statusCode).toBe(403);
    expect(await prisma.forgotPasswordVerificationToken.count({ where: { email: target.email } })).toBe(0);
  });
});
