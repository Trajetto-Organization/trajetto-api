import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clientRateLimitKey,
  lastForwardedAddress,
} from "@/config/rate-limit";

vi.mock("@/env", () => ({
  env: { get RATE_LIMIT_TRUSTED_PROXY() { return mode; } },
}));

let mode = "none";

/**
 * Qual balde uma requisição anônima cai.
 *
 * É a única coisa entre um atacante e força bruta no login e no 2FA, e estava
 * do lado errado: o código lia `cf-connecting-ip` PRIMEIRO — o único cabeçalho
 * que o Traefik da produção não reescreve. Mandar `Cf-Connecting-Ip:
 * 1.2.3.<n>` dava um balde novo por requisição, e os limites de 8/min do login
 * e 4/min do 2FA não prendiam nada.
 */
function requestWith(
  headers: Record<string, string | string[] | undefined>,
  remoteAddress = "10.9.9.9",
  user?: { id: string },
) {
  return {
    headers,
    socket: { remoteAddress },
    user,
  } as never;
}

afterEach(() => {
  mode = "none";
});

describe("uma requisição autenticada", () => {
  it("é limitada pelo usuário, que vem de um JWT verificado", () => {
    // A única metade da chave que o atacante não reescreve — e o que impede
    // uma frota inteira atrás de um NAT de dividir o mesmo balde.
    expect(
      clientRateLimitKey(
        requestWith({ "cf-connecting-ip": "1.2.3.4" }, "10.0.0.1", {
          id: "user-1",
        }),
      ),
    ).toBe("user:user-1");
  });
});

describe("uma requisição anônima, sem proxy configurado", () => {
  it("usa o socket e ignora todo cabeçalho", () => {
    const key = clientRateLimitKey(
      requestWith({
        "cf-connecting-ip": "1.2.3.4",
        "x-forwarded-for": "5.6.7.8",
        "x-real-ip": "9.9.9.9",
      }),
    );

    // O socket é o único endereço que quem manda a requisição não escreve.
    expect(key).toBe("ip:10.9.9.9");
  });

  it("não deixa o atacante escolher o próprio balde", () => {
    const first = clientRateLimitKey(
      requestWith({ "cf-connecting-ip": "1.2.3.1" }),
    );

    const second = clientRateLimitKey(
      requestWith({ "cf-connecting-ip": "1.2.3.2" }),
    );

    // O ataque inteiro em duas linhas: se estas chaves diferissem, cada
    // tentativa de senha teria o próprio limite.
    expect(first).toBe(second);
  });
});

describe("atrás de Traefik ou nginx", () => {
  it("lê a ÚLTIMA entrada de X-Forwarded-For", () => {
    mode = "xff";

    // O primeiro valor é o que o cliente escreveu; o proxy confiável
    // acrescenta o par real no fim.
    expect(
      clientRateLimitKey(
        requestWith({ "x-forwarded-for": "1.2.3.4, 200.160.2.3" }),
      ),
    ).toBe("ip:200.160.2.3");
  });

  it("continua ignorando o cabeçalho da Cloudflare", () => {
    mode = "xff";

    // Este era o furo: o Traefik não reescreve `cf-connecting-ip`, então lê-lo
    // é ler o que o cliente mandou.
    expect(
      clientRateLimitKey(
        requestWith({
          "cf-connecting-ip": "1.2.3.4",
          "x-forwarded-for": "200.160.2.3",
        }),
      ),
    ).toBe("ip:200.160.2.3");
  });

  it("cai no socket quando o cabeçalho não veio", () => {
    mode = "xff";

    expect(clientRateLimitKey(requestWith({}))).toBe("ip:10.9.9.9");
  });
});

describe("atrás da Cloudflare", () => {
  it("lê o cabeçalho que ela sobrescreve", () => {
    mode = "cloudflare";

    expect(
      clientRateLimitKey(requestWith({ "cf-connecting-ip": "200.160.2.3" })),
    ).toBe("ip:200.160.2.3");
  });
});

describe("lendo uma cadeia de encaminhamento", () => {
  it("devolve o último salto", () => {
    expect(lastForwardedAddress("1.1.1.1, 2.2.2.2, 3.3.3.3")).toBe("3.3.3.3");
  });

  it("aguenta espaços e entradas vazias", () => {
    expect(lastForwardedAddress("  1.1.1.1 ,  , 2.2.2.2  ")).toBe("2.2.2.2");
  });

  it("aguenta o cabeçalho repetido, que chega como lista", () => {
    expect(lastForwardedAddress(["1.1.1.1", "2.2.2.2, 3.3.3.3"])).toBe(
      "3.3.3.3",
    );
  });

  it("responde nada quando não há nada", () => {
    expect(lastForwardedAddress(undefined)).toBeNull();
    expect(lastForwardedAddress("")).toBeNull();
    expect(lastForwardedAddress("  ,  ")).toBeNull();
  });
});
