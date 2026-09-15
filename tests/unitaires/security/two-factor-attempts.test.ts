import { beforeEach, describe, expect, it } from "vitest";

import { hash } from "bcrypt";

import { TwoFactorVerificationUseCase } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-usecase";

import { InMemoryUserRepository } from "@/modules/user/repositories/in-memory/in-memory-user-repository";
import { InMemoryUserTokensRepository } from "@/modules/user/repositories/in-memory/in-memory-user-tokens-repository";
import { InMemoryDriverRepository } from "@/modules/driver/repositories/in-memory/in-memory-driver-repository";

import { MAX_TWO_FACTOR_ATTEMPTS } from "@/shared/security/two-factor-rules";

/**
 * Quantos palpites um código de seis dígitos aguenta.
 *
 * O código é `randomInt(100_000, 1_000_000)` e vale quinze minutos. Antes
 * disto, um palpite errado não consumia nada e não contava para nada: a única
 * barreira era o rate limit das rotas anônimas — e ele lia um cabeçalho que o
 * próprio cliente escreve, então não era barreira nenhuma. Um milhão de
 * possibilidades com tentativas ilimitadas é um código que se adivinha.
 */
const EMAIL = "gestora@exemplo.com.br";
const CODE = "123456";

let users: InMemoryUserRepository;
let tokens: InMemoryUserTokensRepository;
let drivers: InMemoryDriverRepository;

let useCase: TwoFactorVerificationUseCase;

beforeEach(async () => {
  users = new InMemoryUserRepository();
  tokens = new InMemoryUserTokensRepository();
  drivers = new InMemoryDriverRepository();

  users.user.push({
    id: "user-1",
    name: "Gestora",
    email: EMAIL,
    password: "nao-usado",
    role: "BUSINESS_ADMIN",
    businessId: "business-1",
    session_version: 0,
  } as never);

  await tokens.createTwoFactorToken({
    email: EMAIL,
    token: await hash(CODE, 6),
    expires: new Date(Date.now() + 15 * 60 * 1000),
  });

  useCase = new TwoFactorVerificationUseCase(
    users as never,
    tokens as never,
    drivers as never,
  );
});

const guess = (twoFactorCode: string) =>
  useCase.execute({ twoFactorCode, email: EMAIL });

describe("errando o código", () => {
  it("é recusado, e conta", async () => {
    await expect(guess("000000")).rejects.toThrow();

    const token = tokens.twoFactorTokens.find((entry) => entry.email === EMAIL);

    expect(token?.attempts).toBe(1);
  });

  it("queima o código depois do teto", async () => {
    for (let attempt = 0; attempt < MAX_TWO_FACTOR_ATTEMPTS; attempt += 1) {
      await expect(guess("000000"), `palpite ${attempt}`).rejects.toThrow();
    }

    // Queimado, não apenas travado: continuar aceitando tentativas num código
    // morto seria um oráculo de "este e-mail tem 2FA pendente" com quinze
    // minutos de duração.
    expect(
      tokens.twoFactorTokens.find((entry) => entry.email === EMAIL),
    ).toBeUndefined();
  });

  it("recusa até o código CERTO depois do teto", async () => {
    for (let attempt = 0; attempt < MAX_TWO_FACTOR_ATTEMPTS; attempt += 1) {
      await expect(guess("000000")).rejects.toThrow();
    }

    // O ponto inteiro: adivinhar na sexta não vale, mesmo acertando.
    await expect(guess(CODE)).rejects.toThrow();
  });

  it("recusa um código que já está no teto e sobreviveu", async () => {
    /**
     * O estado que a pré-verificação protege.
     *
     * No caminho normal o código é APAGADO ao bater no teto, então a checagem
     * de antes da comparação nunca dispara — e uma mutação que a removesse
     * passaria despercebida. Mas o apagamento pode falhar: uma queda entre o
     * incremento e o delete, ou um erro do banco, deixa a linha no teto e
     * viva. Sem a pré-verificação, esse código volta a aceitar palpites para
     * sempre.
     */
    const token = tokens.twoFactorTokens.find((entry) => entry.email === EMAIL);

    token!.attempts = MAX_TWO_FACTOR_ATTEMPTS;

    await expect(guess(CODE)).rejects.toThrow();

    // E é queimado agora, para não ficar aceitando tentativas de novo.
    expect(
      tokens.twoFactorTokens.find((entry) => entry.email === EMAIL),
    ).toBeUndefined();
  });

  it("recusa sempre com a mesma frase", async () => {
    // Uma mensagem distinta para "você errou cinco vezes" contaria ao atacante
    // que ele está no e-mail certo.
    const first = await guess("000000").catch((error) => error.message);

    for (let attempt = 1; attempt < MAX_TWO_FACTOR_ATTEMPTS; attempt += 1) {
      await guess("000000").catch(() => undefined);
    }

    const burned = await guess(CODE).catch((error) => error.message);

    expect(burned).toBe(first);
  });
});

describe("acertando o código", () => {
  it("funciona depois de alguns erros", async () => {
    // Quem digitou errado duas vezes é a maioria dos casos reais, e o limite
    // não pode custar a entrada dessa pessoa.
    await guess("000000").catch(() => undefined);
    await guess("111111").catch(() => undefined);

    const session = await guess(CODE);

    expect(session.token).toBeTruthy();
  });

  it("consome o código, que não serve duas vezes", async () => {
    await guess(CODE);

    expect(
      tokens.twoFactorTokens.find((entry) => entry.email === EMAIL),
    ).toBeUndefined();
  });
});

describe("pedindo um código novo", () => {
  it("zera a contagem", async () => {
    await guess("000000").catch(() => undefined);
    await guess("111111").catch(() => undefined);

    await tokens.createTwoFactorToken({
      email: EMAIL,
      token: await hash("654321", 6),
      expires: new Date(Date.now() + 15 * 60 * 1000),
    });

    const token = tokens.twoFactorTokens.find((entry) => entry.email === EMAIL);

    // Herdar a contagem travaria o usuário legítimo que pediu outro código.
    // E do outro lado: sem zerar, um atacante no teto pediria outro e
    // continuaria de onde parou — o que o e-mail ao dono da conta denuncia.
    expect(token?.attempts).toBe(0);
  });
});
