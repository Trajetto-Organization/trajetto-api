import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { randomUUID } from "node:crypto";
import { createPrismaClient } from "@/shared/database/database-client";

/**
 * A driver on a build of the app from before presigned uploads.
 *
 * That build — the only one the mobile repository's main branch can produce —
 * posts fueling and checklist photos as multipart. Those two create routes
 * accept it again, through a temporary adapter
 * (legacy-multipart-uploads.test.ts). Every OTHER route still refuses
 * multipart before the handler runs, and the app shows the response `message`
 * in a toast. It used to read "Unsupported Media Type: multipart/form-data;
 * boundary=…"; what the driver reads now is something they can act on.
 */
const prisma = createPrismaClient();

let app: Awaited<typeof import("@/http")>["app"];
let accessToken = "";

const BUSINESS = "018fd900-0000-7000-8000-00000000000a";
const USER = "018fd900-0000-7000-8000-0000000000a1";

/** What React Native's fetch sends for a FormData body. */
const BOUNDARY = "----WebKitFormBoundaryRN" + randomUUID().slice(0, 8);

function multipartBody(): string {
  return [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="liters"',
    "",
    "42",
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="odometer_photo"; filename="odometer.jpg"',
    "Content-Type: image/jpeg",
    "",
    "\xff\xd8\xff\xe0fake-jpeg-bytes",
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: BUSINESS,
      corporate_reason: "Transportadora Legada",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "55666777000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `legado-${randomUUID()}@exemplo.com.br`,
    },
  });

  const user = await prisma.user.create({
    data: {
      id: USER,
      name: "Pessoa Frota",
      email: `frota-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_ADMIN",
      businessId: BUSINESS,
    },
  });

  const { issueSessionTokenPair } = await import(
    "@/modules/user/services/session-service"
  );

  const pair = issueSessionTokenPair(user as never);

  await prisma.refreshToken.create({
    data: {
      userId: USER,
      token_hash: pair.refreshTokenHash,
      jti: pair.refreshJti,
      family_id: pair.familyId,
      expires_in: pair.expiresAt,
    },
  });

  accessToken = pair.token;

  ({ app } = await import("@/http"));
  await app.ready();
}, 120_000);

afterAll(async () => {
  await prisma.refreshToken.deleteMany({ where: { userId: USER } });
  await prisma.user.deleteMany({ where: { id: USER } });
  await prisma.business.deleteMany({ where: { id: BUSINESS } });

  await app?.close();
  await prisma.$disconnect();
}, 60_000);

describe("a fueling edit posted as multipart by an outdated app", () => {
  it("is refused with a sentence the driver can act on", async () => {
    // Not one of the two create routes the legacy adapter serves.
    const response = await app.inject({
      method: "PATCH",
      url: `/fuel/update-fuel/${randomUUID()}/business/${BUSINESS}`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
        "user-agent": "okhttp/4.9.2",
      },
      payload: multipartBody(),
    });

    expect(response.statusCode).toBe(415);

    const body = response.json();

    expect(body.code).toBe("CLIENT_OUTDATED");
    expect(body.message).toMatch(/Atualize o aplicativo Trajetto/);
    expect(body.message).not.toMatch(/multipart|boundary|Media Type/i);
  });
});

describe("the same refusal on any other route", () => {
  it("reads the same way; any other wrong type keeps Fastify's sentence", async () => {
    const multipart = await app.inject({
      method: "POST",
      url: "/user/session",
      headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartBody(),
    });

    expect(multipart.statusCode).toBe(415);
    expect(multipart.json().code).toBe("CLIENT_OUTDATED");

    // A content type that is simply wrong keeps Fastify's own sentence.
    const text = await app.inject({
      method: "POST",
      url: "/user/session",
      headers: { "content-type": "application/xml" },
      payload: "<a/>",
    });

    expect(text.statusCode).toBe(415);
    expect(text.json().code).toBe("MALFORMED_REQUEST");
  });
});
