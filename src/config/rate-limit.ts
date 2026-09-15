import { FastifyRequest } from "fastify";

import { env } from "@/env";
import { AppError } from "@/shared/errors/AppError";

/**
 * The single key and the single refusal for every rate limiter in the app.
 *
 * There used to be two of each — one inline in http.ts for the global limit and
 * one in the per-route helper — and they disagreed on both counts.
 */

/**
 * Qual cabeçalho, se algum, diz de onde veio a requisição.
 *
 * - `none`: só o endereço do socket. Correto sem proxy nenhum na frente; atrás
 *   de um, coloca a internet inteira num balde só, e aí o limite de login vira
 *   negação de serviço contra todo mundo por causa de um atacante.
 * - `xff`: `X-Forwarded-For`, lendo a ÚLTIMA entrada. Um proxy confiável
 *   ACRESCENTA o endereço do par no fim; o que o cliente escreveu fica antes.
 *   É o valor certo para Traefik e nginx.
 * - `cloudflare`: `CF-Connecting-IP`, que a Cloudflare SOBRESCREVE. Só vale se
 *   a origem for inalcançável sem passar por lá.
 */
type TrustedProxyMode = "none" | "xff" | "cloudflare";

/**
 * Só o último salto, nunca o primeiro.
 *
 * O primeiro valor de `X-Forwarded-For` é o que o CLIENTE escreveu — um
 * atacante manda `X-Forwarded-For: 1.2.3.<n>` e ganha um balde novo por
 * requisição. O proxy confiável acrescenta o endereço real no fim, então é o
 * fim que vale.
 */
function lastForwardedAddress(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[value.length - 1] : value;

  if (!raw) return null;

  const parts = raw.split(",").map((part) => part.trim()).filter(Boolean);

  return parts.length > 0 ? parts[parts.length - 1] : null;
}

/**
 * Who is being limited.
 *
 * An authenticated request is keyed by the USER, which comes from a verified
 * JWT and cannot be forged. That matters twice over: it is the only half of
 * the key an attacker cannot rewrite, and it is what keeps a fleet from
 * sharing one bucket. Brazilian carriers put whole cities behind one CGNAT
 * address, and a dispatch office is one NAT — under an IP key, a hundred
 * drivers of the same carrier, or thirty dispatchers in one room, spend the
 * same 300 requests a minute and start getting refused with no abuse at all.
 *
 * As anônimas (login, 2FA, recuperação de senha) não têm usuário ainda e caem
 * no endereço. Esse endereço vinha de cabeçalhos que o CLIENTE escreve, e a
 * ordem era a pior possível: `cf-connecting-ip` primeiro, que é justamente o
 * único que o Traefik da produção NÃO reescreve. Qualquer um mandava
 * `Cf-Connecting-Ip: 1.2.3.<n>` e ganhava um balde novo a cada tentativa — o
 * limite de 8/min do login e o de 4/min do 2FA não prendiam nada.
 *
 * Agora a fonte é explícita e configurada, e a escolha é de quem opera a
 * borda, não de quem manda a requisição.
 */
function clientRateLimitKey(request: FastifyRequest): string {
  if (request.user?.id) {
    return `user:${request.user.id}`;
  }

  const mode = (env.RATE_LIMIT_TRUSTED_PROXY ?? "none") as TrustedProxyMode;

  const forwarded =
    mode === "cloudflare"
      ? lastForwardedAddress(request.headers["cf-connecting-ip"])
      : mode === "xff"
        ? lastForwardedAddress(request.headers["x-forwarded-for"])
        : null;

  // O socket é o último recurso e o único que ninguém escreve.
  const address = forwarded ?? request.socket.remoteAddress ?? "unknown";

  return `ip:${address}`;
}

/**
 * What the client gets when it crosses the limit.
 *
 * @fastify/rate-limit THROWS whatever the builder returns, and the app's error
 * handler only recognises AppError. A plain object therefore fell through to
 * the unknown-error branch: the caller was told "Internal server error" with
 * status 500, and every throttled request was logged at error level, burying
 * the real 500s. An AppError carries the status and the code the handler needs.
 */
function rateLimitExceeded(message?: string): AppError {
  return new AppError(
    message ??
      "Limite de requisições excedido. Por favor, tente novamente mais tarde.",
    429,
    "RATE_LIMITED",
  );
}

export {
  clientRateLimitKey,
  lastForwardedAddress,
  rateLimitExceeded,
  type TrustedProxyMode,
};
