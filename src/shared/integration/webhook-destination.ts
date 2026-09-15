import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Onde um webhook pode e não pode ser entregue.
 *
 * Um cliente cadastra a URL do próprio sistema, e o nosso servidor faz o POST.
 * Isso é, literalmente, "peça ao servidor de vocês que busque este endereço" —
 * e sem um freio, o endereço pode ser a rede interna DA PLATAFORMA. Um admin
 * de qualquer transportadora poderia apontar um endpoint para
 * `169.254.169.254` e ler as credenciais de instância, ou varrer portas
 * internas pelo tempo de resposta.
 *
 * O que fecha o buraco, e por que cada peça é necessária:
 *
 * - Resolver o nome e olhar o IP, não o texto. `https://interno.exemplo.com`
 *   pode apontar para 10.0.0.5, e uma lista de nomes proibidos nunca alcança
 *   isso.
 * - Checar A CADA ENVIO, não só no cadastro. Um nome que resolvia para um IP
 *   público no cadastro pode passar a resolver para um privado depois — é o
 *   ataque conhecido como DNS rebinding, e uma validação só na escrita é
 *   exatamente o que ele contorna.
 * - Recusar TODOS os endereços do nome, não o primeiro. Um nome com um A
 *   público e um AAAA em `::1` passaria por qualquer verificação que olhasse
 *   só um.
 * - Não seguir redirecionamento. O `https://` do cadastro só vale para o
 *   primeiro salto; um 302 para `http://169.254.169.254` anula a regra
 *   inteira. Um receptor de webhook não tem motivo legítimo para redirecionar.
 */
interface DestinationVerdict {
  allowed: boolean;

  /** A frase que o monitor mostra. Nunca o IP — ver abaixo. */
  reason?: string;
}

/**
 * Faixas que nunca são um cliente.
 *
 * Escritas como comparação numérica e não como regex sobre texto: `010.0.0.5`,
 * `0x0A000005` e `167772161` são todas 10.0.0.5 para o resolvedor, e um
 * `startsWith("10.")` não vê nenhuma delas.
 */
function isPrivateIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);

  if (parts.length !== 4 || parts.some((part) => Number.isNaN(part))) {
    return true;
  }

  const [a, b] = parts;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;

  // Metadados de nuvem e o resto do link-local.
  if (a === 169 && b === 254) return true;

  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;

  // Compartilhado por operadora (CGNAT) e benchmark.
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;

  // Multicast e reservado.
  if (a >= 224) return true;

  return false;
}

function isPrivateIPv6(address: string): boolean {
  const value = address.toLowerCase().split("%")[0];

  if (value === "::1" || value === "::") return true;

  // Link-local, unique-local e multicast.
  if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) {
    return true;
  }

  if (value.startsWith("ff")) return true;

  // IPv4 mapeado: `::ffff:10.0.0.5` é 10.0.0.5 com outra roupa.
  const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);

  if (mapped) return isPrivateIPv4(mapped[1]);

  return false;
}

function isPrivateAddress(address: string): boolean {
  const family = isIP(address);

  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);

  return true;
}

/**
 * Nomes que nunca são um cliente, mesmo que resolvam para um IP público.
 *
 * A checagem de IP é a que decide; esta pega o caso em que a resolução falha
 * ou é interceptada, e diz a coisa certa no monitor.
 */
const BLOCKED_HOST_SUFFIXES = [
  "localhost",
  ".localhost",
  ".local",
  ".internal",
  ".cluster.local",
];

const BLOCKED_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

function hasBlockedName(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (BLOCKED_HOSTS.has(host)) return true;

  return BLOCKED_HOST_SUFFIXES.some(
    (suffix) => host === suffix.replace(/^\./, "") || host.endsWith(suffix),
  );
}

/**
 * Decide se este envio pode sair.
 *
 * A frase de recusa nunca inclui o IP resolvido. O monitor é visível para o
 * próprio cliente, e devolver "10.0.0.5 é privado" transforma a mensagem de
 * erro no oráculo de varredura que a checagem existe para impedir.
 */
async function verifyWebhookDestination(
  url: string,
): Promise<DestinationVerdict> {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch (error) {
    return { allowed: false, reason: "A URL do endpoint é inválida." };
  }

  // Também na saída, e não só no cadastro: uma linha gravada antes desta regra
  // existir continuaria valendo para sempre.
  if (parsed.protocol !== "https:") {
    return {
      allowed: false,
      reason: "O endpoint precisa ser https.",
    };
  }

  if (hasBlockedName(parsed.hostname)) {
    return {
      allowed: false,
      reason: "O endpoint precisa ser um endereço alcançável pela internet.",
    };
  }

  // Um literal já é a resposta; não há o que resolver.
  if (isIP(parsed.hostname)) {
    return isPrivateAddress(parsed.hostname)
      ? {
          allowed: false,
          reason: "O endpoint precisa ser um endereço alcançável pela internet.",
        }
      : { allowed: true };
  }

  let addresses: Array<{ address: string }>;

  try {
    addresses = await lookup(parsed.hostname, { all: true });
  } catch (error) {
    return {
      allowed: false,
      reason: "Não foi possível resolver o endereço do endpoint.",
    };
  }

  if (addresses.length === 0) {
    return {
      allowed: false,
      reason: "Não foi possível resolver o endereço do endpoint.",
    };
  }

  // TODOS, não o primeiro: um nome com um A público e um AAAA em `::1`
  // passaria por qualquer verificação que olhasse só um.
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    return {
      allowed: false,
      reason: "O endpoint precisa ser um endereço alcançável pela internet.",
    };
  }

  return { allowed: true };
}

/**
 * Cabeçalhos que o cliente não pode escrever.
 *
 * O mapa do cliente existe para a autenticação que o gateway DELE exige. O que
 * ele não pode fazer é sobrescrever os nossos: a assinatura é a garantia que a
 * documentação pública promete, e um cliente que a substitui por um valor
 * qualquer transforma um receptor compartilhado em alvo de replay. `Host`,
 * `Content-Length` e afins mudam para ONDE e COMO a requisição vai — que é
 * justamente o que a verificação de destino acabou de decidir.
 */
const RESERVED_WEBHOOK_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "transfer-encoding",
  "connection",
  "upgrade",
  "user-agent",
  "x-trajetto-topic",
  "x-trajetto-delivery",
  "x-trajetto-signature",
]);

function reservedHeaderNames(headers: Record<string, string>): string[] {
  return Object.keys(headers).filter((name) =>
    RESERVED_WEBHOOK_HEADERS.has(name.trim().toLowerCase()),
  );
}

/** O mapa do cliente, sem o que ele não pode escrever. */
function safeWebhookHeaders(
  headers: Record<string, string> | null | undefined,
): Record<string, string> {
  if (!headers) return {};

  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => !RESERVED_WEBHOOK_HEADERS.has(name.trim().toLowerCase()),
    ),
  );
}

export {
  RESERVED_WEBHOOK_HEADERS,
  hasBlockedName,
  isPrivateAddress,
  reservedHeaderNames,
  safeWebhookHeaders,
  verifyWebhookDestination,
  type DestinationVerdict,
};
