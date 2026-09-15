import { describe, expect, it } from "vitest";

import {
  RESERVED_WEBHOOK_HEADERS,
  hasBlockedName,
  isPrivateAddress,
  reservedHeaderNames,
  safeWebhookHeaders,
  verifyWebhookDestination,
} from "@/shared/integration/webhook-destination";

/**
 * "Peça ao servidor de vocês que busque este endereço."
 *
 * É o que um webhook é, visto de fora, e é por isso que o destino precisa de
 * freio. Sem ele, o admin de QUALQUER transportadora aponta um endpoint para
 * `169.254.169.254` e lê as credenciais da instância pelo próprio monitor —
 * que devolve o corpo da resposta para ele, com status e latência de brinde,
 * o que por si só é um scanner de portas internas.
 */
describe("endereços que nunca são um cliente", () => {
  it("recusa loopback, privado e link-local", () => {
    for (const address of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.5",
      "172.16.0.1",
      "172.31.255.254",
      "192.168.1.1",
      "169.254.169.254",
      "0.0.0.0",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("recusa as faixas que ninguém lembra", () => {
    // CGNAT de operadora e a faixa de benchmark. Uma lista que só cobre
    // 10/172/192 deixa as duas passando.
    expect(isPrivateAddress("100.64.0.1")).toBe(true);
    expect(isPrivateAddress("198.18.0.1")).toBe(true);

    expect(isPrivateAddress("224.0.0.1")).toBe(true);
  });

  it("recusa o IPv6 equivalente", () => {
    for (const address of ["::1", "::", "fe80::1", "fd00::1", "fc00::1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("recusa um IPv4 vestido de IPv6", () => {
    // `::ffff:10.0.0.5` é 10.0.0.5 com outra roupa, e uma verificação que só
    // olhasse o prefixo deixaria passar.
    expect(isPrivateAddress("::ffff:10.0.0.5")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);
  });

  it("aceita um endereço público de verdade", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("200.160.2.3")).toBe(false);
    expect(isPrivateAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("recusa o que não é um endereço", () => {
    // Na dúvida, não sai. O contrário — deixar passar o que não soube ler — é
    // a forma mais comum de uma lista de bloqueio ser contornada.
    expect(isPrivateAddress("nao-e-um-ip")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("nomes que nunca são um cliente", () => {
  it("recusa localhost e os domínios internos", () => {
    for (const host of [
      "localhost",
      "api.localhost",
      "servico.internal",
      "algo.cluster.local",
      "impressora.local",
      "metadata.google.internal",
    ]) {
      expect(hasBlockedName(host), host).toBe(true);
    }
  });

  it("não recusa um domínio de cliente que apenas parece parecido", () => {
    // `localhost.exemplo.com.br` é um domínio público legítimo.
    expect(hasBlockedName("localhost.exemplo.com.br")).toBe(false);
    expect(hasBlockedName("erp.exemplo.com.br")).toBe(false);
  });
});

describe("decidindo um envio", () => {
  it("recusa http, mesmo que a linha já estivesse gravada", () => {
    // A regra existe no schema desde sempre, mas uma linha gravada antes dela
    // continuaria valendo para sempre sem esta segunda tranca.
    return expect(
      verifyWebhookDestination("http://erp.exemplo.com.br/hook"),
    ).resolves.toMatchObject({ allowed: false });
  });

  it("recusa um literal privado sem precisar resolver nada", async () => {
    const verdict = await verifyWebhookDestination("https://169.254.169.254/");

    expect(verdict.allowed).toBe(false);
  });

  it("recusa um nome interno", async () => {
    expect(
      (await verifyWebhookDestination("https://localhost:9200/_cat")).allowed,
    ).toBe(false);
  });

  it("recusa uma URL que não é uma URL", async () => {
    expect((await verifyWebhookDestination("nao é url")).allowed).toBe(false);
  });

  it("nunca conta qual endereço encontrou", async () => {
    // O monitor é visível para o próprio cliente. Devolver "10.0.0.5 é
    // privado" transformaria a mensagem de erro no oráculo de varredura que a
    // verificação existe para impedir.
    const verdict = await verifyWebhookDestination("https://127.0.0.1/hook");

    expect(verdict.reason).toBeTruthy();
    expect(verdict.reason).not.toContain("127");
    expect(verdict.reason).not.toContain("privado");
  });
});

describe("cabeçalhos que o cliente não escreve", () => {
  it("reconhece os reservados, em qualquer caixa", () => {
    expect(
      reservedHeaderNames({
        "X-Trajetto-Signature": "forjada",
        "x-trajetto-topic": "outro",
        HOST: "interno.svc",
        "X-Api-Key": "do-cliente",
      }).sort(),
    ).toEqual(["HOST", "X-Trajetto-Signature", "x-trajetto-topic"]);
  });

  it("deixa passar o que é do cliente", () => {
    expect(reservedHeaderNames({ Authorization: "Bearer deles" })).toEqual([]);
  });

  it("filtra os reservados e mantém o resto", () => {
    expect(
      safeWebhookHeaders({
        "X-Trajetto-Signature": "forjada",
        Authorization: "Bearer deles",
        "X-Api-Key": "abc",
      }),
    ).toEqual({ Authorization: "Bearer deles", "X-Api-Key": "abc" });
  });

  it("protege a assinatura, que é a garantia publicada", () => {
    // Um cliente que substituísse a assinatura por um valor qualquer
    // transformaria um receptor compartilhado em alvo de replay.
    expect(RESERVED_WEBHOOK_HEADERS.has("x-trajetto-signature")).toBe(true);
    expect(RESERVED_WEBHOOK_HEADERS.has("host")).toBe(true);
  });

  it("aceita a ausência do mapa", () => {
    expect(safeWebhookHeaders(null)).toEqual({});
    expect(safeWebhookHeaders(undefined)).toEqual({});
  });
});
