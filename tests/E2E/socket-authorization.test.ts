import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sign } from "jsonwebtoken";
import auth from "@/config/auth";

/**
 * O socket e a permissão que mudou por baixo dele.
 *
 * `socket.data.isChatStaff` era decidido UMA vez, no handshake, e o chat da
 * empresa é uma SALA — ou seja, o próprio canal de dados. Um usuário que
 * perdeu `delivery_manage` continuava recebendo toda mensagem da empresa pelo
 * resto da conexão: corpo, motorista e URL assinada do anexo. O HTTP recusava
 * a partir da requisição seguinte; o socket, nunca.
 *
 * A correção NÃO é derrubar a conexão. `permissions_changed` mexe em
 * autorização, não em autenticação, e um disconnect do servidor não reconecta
 * sozinho no socket.io-client — deixaria a empresa inteira sem tempo real até
 * a próxima recarga. O certo é tirar da sala quem não pertence mais, e é isso
 * que este arquivo prova, pelo canal de verdade.
 */
const prisma = new PrismaClient();

const CARRIER = "018fd000-0000-7000-8000-00000000000a";
const STAFF = "018fd000-0000-7000-8000-0000000000a1";

let server: Server;
let port = 0;

let token: string;
let profileAccessId = "";

let io: typeof import("@/websocket");
let client: {
  on: Function;
  removeAllListeners: Function;
  disconnect: () => void;
  emit: Function;
};

/**
 * O cliente mora no repositório web: a API é servidor e não o tem.
 *
 * Uma dependência de teste no pacote de produção é uma dependência que alguém
 * acaba importando em produção.
 */
async function connectClient(): Promise<typeof client> {
  const entry = pathToFileURL(
    resolve(
      process.cwd(),
      "..",
      "trajetto-fleet-manager-ui",
      "node_modules",
      "socket.io-client",
      "build",
      "esm",
      "index.js",
    ),
  ).href;

  const { io: connect } = await import(/* @vite-ignore */ entry);

  return new Promise((resolve, reject) => {
    const socket = connect(`http://127.0.0.1:${port}`, {
      auth: { token },
      transports: ["websocket"],
      reconnection: false,
    });

    const timer = setTimeout(() => reject(new Error("timeout")), 10_000);

    socket.on("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on("connect_error", (error: Error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/** Espera uma mensagem de chat, ou desiste. */
function waitForChat(timeoutMs = 2500): Promise<unknown | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);

    client.on("chatMessage", (message: unknown) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

beforeAll(async () => {
  await prisma.business.create({
    data: {
      id: CARRIER,
      corporate_reason: "Transportadora do Socket",
      cep: "01001000",
      city: "São Paulo",
      uf: "SP",
      street: "Rua",
      address_number: "1",
      cnpj: "99222888000101",
      cnae: "4930202",
      responsible_name: "Responsável",
      telephone: "11999999999",
      email: `socket-${randomUUID()}@exemplo.com.br`,
    },
  });

  const profile = await prisma.profileAccess.create({
    data: {
      name: "Atendimento",
      businessId: CARRIER,
      permissions: {
        create: [
          {
            permissionKey: "delivery_manage",
            action: "Gerenciar entregas",
            canRead: true,
            canWrite: false,

            // `businessId` também na permissão: a chave única é
            // (action, profileAccessId, businessId).
            businessId: CARRIER,
          },
        ],
      },
    },
  });

  profileAccessId = profile.id;

  await prisma.user.create({
    data: {
      id: STAFF,
      name: "Atendente",
      email: `atendente-${randomUUID()}@exemplo.com.br`,
      password: "nao-usado",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      profileAccessId: profile.id,
    },
  });

  const familyId = randomUUID();

  await prisma.refreshToken.create({
    data: {
      userId: STAFF,
      token_hash: randomUUID(),
      jti: randomUUID(),
      family_id: familyId,
      expires_in: new Date(Date.now() + 60 * 60 * 1000),
    },
  });

  token = sign(
    {
      tokenType: "access",
      role: "BUSINESS_USER",
      businessId: CARRIER,
      driverId: null,
      sessionVersion: 0,
      familyId,
    },
    auth.secret_token,
    { subject: STAFF, expiresIn: "1h" },
  );

  server = createServer();

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  port = (server.address() as AddressInfo).port;

  io = await import("@/websocket");
  await io.initializeSocketIO(server);

  client = await connectClient();

  // O handler de conexão do servidor é assíncrono — ele lê o usuário, o
  // motorista e a família do refresh antes de entrar nas salas. Medir antes
  // disso mediria a corrida, não a regra.
  await new Promise((resolve) => setTimeout(resolve, 1500));
}, 120_000);

afterAll(async () => {
  client?.disconnect();

  await io?.shutdownSocketIO();

  await new Promise<void>((resolve) => server.close(() => resolve()));

  await prisma.refreshToken.deleteMany({ where: { userId: STAFF } });
  await prisma.user.deleteMany({ where: { id: STAFF } });

  await prisma.permission.deleteMany({ where: { profileAccessId } });
  await prisma.profileAccess.deleteMany({ where: { id: profileAccessId } });

  await prisma.business.deleteMany({ where: { id: CARRIER } });

  await prisma.$disconnect();
});

const anyMessage = () => ({
  id: randomUUID(),
  threadId: randomUUID(),
  body: "segredo da operação",
  kind: "TEXT",
});

describe("enquanto a permissão vale", () => {
  it("o atendente recebe o chat da empresa", async () => {
    const received = waitForChat();

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    expect(await received).not.toBeNull();
  });
});

describe("depois que a permissão é revogada", () => {
  it("o atendente para de receber, sem perder a conexão", async () => {
    // A revogação como o produto a faz: a permissão muda no banco e o evento
    // de segurança sai.
    await prisma.permission.updateMany({
      where: { profileAccessId, permissionKey: "delivery_manage" },
      data: { canRead: false, canWrite: false },
    });

    io.sendSecurityEventToBusiness(CARRIER, { reason: "permissions_changed" });

    // A reavaliação lê o banco por socket; um instante para ela acontecer.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const received = waitForChat();

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    // O ponto inteiro: o HTTP já recusava a partir da requisição seguinte, e
    // o socket continuava entregando o corpo da mensagem pelo resto da
    // conexão.
    expect(await received).toBeNull();
  });

  it("e a conexão continua de pé", async () => {
    // Derrubar seria pior: um disconnect do servidor não reconecta sozinho, e
    // a empresa ficaria sem tempo real até a próxima recarga de página.
    const online = await io.getOnlineUserIdsForBusiness(CARRIER);

    expect(online).toContain(STAFF);
  });
});

describe("quando a reavaliação não consegue ler o banco", () => {
  it("tira da sala mesmo assim", { timeout: 30_000 }, async () => {
    /**
     * O ramo que só existe para o dia ruim.
     *
     * Um erro de leitura não pode ser o motivo pelo qual alguém continua
     * ouvindo o que não deveria. Na dúvida, sai da sala — recolocar custa um
     * `chatSubscribe`, e é o próprio cliente que faz isso ao redesenhar a
     * tela.
     */
    // A permissão volta ANTES da conexão, senão o segundo cliente entra já
    // sem ser atendimento e o teste passaria sem nunca ter estado na sala —
    // que foi exatamente o que aconteceu na primeira versão deste teste.
    await prisma.permission.updateMany({
      where: { profileAccessId, permissionKey: "delivery_manage" },
      data: { canRead: true },
    });

    const second = await connectClient();

    await new Promise((resolve) => setTimeout(resolve, 1200));

    // E provado: ele ESTÁ na sala antes de qualquer coisa.
    const before = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);

      second.on("chatMessage", (message: unknown) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    expect(await before, "o segundo cliente não entrou na sala").not.toBeNull();

    second.removeAllListeners("chatMessage");

    const { UserRepository } = await import(
      "@/modules/user/repositories/user-repository"
    );

    const original = UserRepository.prototype.findUserById;

    UserRepository.prototype.findUserById = async () => {
      throw new Error("Can't reach database server");
    };

    try {
      io.sendSecurityEventToBusiness(CARRIER, { reason: "permissions_changed" });

      await new Promise((resolve) => setTimeout(resolve, 1500));
    } finally {
      UserRepository.prototype.findUserById = original;
    }

    const received = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 2500);

      second.on("chatMessage", (message: unknown) => {
        clearTimeout(timer);
        resolve(message);
      });
    });

    io.sendChatMessageEvent(CARRIER, null, anyMessage() as never);

    expect(await received).toBeNull();

    second.disconnect();
  });
});
