import { createHash } from "node:crypto";

import {
  BUSINESS_API_RATE_PER_MINUTE,
  PLATFORM_API_KEY_RATE_CEILING,
  RESERVED_API_SCOPES,
  TENANT_API_KEY_RATE_CEILING,
  reservedScopesPhrase,
} from "./api-key-rules";
import {
  ALL_TOPICS,
  FAMILY_WILDCARDS,
  TOPIC_DESCRIPTIONS,
} from "./webhook-catalogue";
import {
  TOPIC_PAYLOAD,
  WEBHOOK_PAYLOAD_SCHEMAS,
} from "./webhook-payload-schemas";

import {
  MAX_CONSECUTIVE_FAILURES,
  REPLAY_WINDOW_DAYS,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
} from "./webhook-dispatch-rules";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_SECRET_ROTATION_GRACE_MS,
} from "./webhook-signature";
import { MAX_API_KEY_AUTH_FAILURES_PER_MINUTE } from "./integration-rate-guard";

import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";

import {
  SCALAR_SCRIPT,
  scalarConfigurationAttribute,
} from "@/routes/documentation/public-docs-console";
import {
  finishPublicDocument,
  publicDocsOptionsFromEnv,
  type PublicDocsOptions,
} from "@/routes/documentation/public-docs-reference";

/**
 * The reference an integrator reads, and only that.
 *
 * `/docs` documents the whole product — every admin endpoint, every internal
 * schema, every error code. Handing that to anyone who asks is handing an
 * attacker the map; handing it to a CUSTOMER is worse in a quieter way,
 * because they will build against an internal endpoint that was never a
 * promise and we will break it on a Tuesday.
 *
 * So the public portal is built by SUBTRACTION from the same document the
 * application actually serves. Generated, not written: a reference maintained
 * by hand is a reference that is wrong, and the failure is silent — the
 * integrator believes it.
 */
interface OpenApiDocument {
  openapi?: string;
  info?: Record<string, unknown>;
  servers?: unknown[];
  paths?: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  tags?: unknown[];
  [key: string]: unknown;
}

/** Everything an API key can reach, and nothing a session can. */
const PUBLIC_PREFIX = "/integration/v1";

/** `[30_000, 120_000, 3_600_000]` → "30 s, 2 min e 1 h". */
function formatDelays(delays: number[]): string {
  const labels = delays.map((ms) =>
    ms < 60_000
      ? `${ms / 1000} s`
      : ms < 3_600_000
        ? `${ms / 60_000} min`
        : `${ms / 3_600_000} h`,
  );

  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} e ${labels[labels.length - 1]}`
    : labels.join("");
}

/**
 * Verifying a call, in the three languages integrators ask for most.
 *
 * The HMAC key is the WHOLE secret, `whsec_` prefix included, as UTF-8 bytes.
 * Integrators used to the Svix convention strip the prefix (or base64-decode
 * what follows it) and every verification fails (DLVB-26). The Node sample is
 * executed by the test suite against a signature this API produced, so the
 * page cannot publish code that does not verify.
 */
const NODE_VERIFICATION_SAMPLE = [
  'const crypto = require("node:crypto");',
  "",
  "// secret: o segredo inteiro, com o prefixo whsec_ (não remova nada).",
  "// rawBody: o corpo EXATO recebido, antes de qualquer JSON.parse.",
  "// Cabeçalho ausente ou malformado devolve false, nunca uma exceção.",
  `function verifyTrajetto(secret, rawBody, header, toleranceSeconds = ${SIGNATURE_TOLERANCE_SECONDS}) {`,
  '  if (typeof header !== "string") return false;',
  "",
  '  const parts = header.split(",").map((part) => part.trim().split("="));',
  '  const timestamp = Number(parts.find(([key]) => key === "t")?.[1]);',
  "  const signatures = parts",
  '    .filter(([key]) => key === "v1")',
  "    .map(([, value]) => value);",
  "",
  "  if (!Number.isFinite(timestamp)) return false;",
  "  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;",
  "",
  "  const expected = crypto",
  '    .createHmac("sha256", secret)',
  "    .update(`${timestamp}.${rawBody}`)",
  '    .digest("hex");',
  "",
  "  // Só hexadecimal de 64 caracteres chega ao timingSafeEqual: outro valor",
  "  // do mesmo tamanho encurtaria o buffer e a comparação lançaria erro.",
  "  return signatures.some(",
  "    (signature) =>",
  "      /^[0-9a-f]{64}$/.test(signature) &&",
  "      crypto.timingSafeEqual(",
  '        Buffer.from(signature, "hex"),',
  '        Buffer.from(expected, "hex"),',
  "      ),",
  "  );",
  "}",
].join("\n");

const PHP_VERIFICATION_SAMPLE = [
  "<?php",
  "// $secret: o segredo inteiro, com o prefixo whsec_.",
  "// $rawBody = file_get_contents('php://input');",
  "// $header = $_SERVER['HTTP_X_TRAJETTO_SIGNATURE'] ?? null;",
  "// Cabeçalho ausente ou malformado devolve false, nunca uma exceção.",
  `function verifyTrajetto(string $secret, string $rawBody, ?string $header, int $tolerance = ${SIGNATURE_TOLERANCE_SECONDS}): bool {`,
  "    if ($header === null || $header === '') { return false; }",
  "    $timestamp = null;",
  "    $signatures = [];",
  "    foreach (explode(',', $header) as $part) {",
  "        [$key, $value] = array_pad(explode('=', trim($part), 2), 2, '');",
  "        if ($key === 't') { $timestamp = (int) $value; }",
  "        if ($key === 'v1') { $signatures[] = $value; }",
  "    }",
  "    if ($timestamp === null || abs(time() - $timestamp) > $tolerance) { return false; }",
  "    $expected = hash_hmac('sha256', $timestamp . '.' . $rawBody, $secret);",
  "    foreach ($signatures as $signature) {",
  "        if (hash_equals($expected, $signature)) { return true; }",
  "    }",
  "    return false;",
  "}",
].join("\n");

const PYTHON_VERIFICATION_SAMPLE = [
  "import hashlib, hmac, time",
  "from typing import Optional",
  "",
  "# secret: o segredo inteiro, com o prefixo whsec_.",
  "# raw_body: os bytes EXATOS recebidos (request.get_data() no Flask).",
  "# Cabeçalho ausente ou malformado devolve False, nunca uma exceção.",
  `def verify_trajetto(secret: str, raw_body: bytes, header: Optional[str], tolerance: int = ${SIGNATURE_TOLERANCE_SECONDS}) -> bool:`,
  "    if not isinstance(header, str):",
  "        return False",
  '    parts = [part.strip().split("=", 1) for part in header.split(",") if "=" in part]',
  '    timestamps = [value for key, value in parts if key == "t"]',
  '    signatures = [value for key, value in parts if key == "v1"]',
  "    try:",
  "        timestamp = int(timestamps[0])",
  "    except (IndexError, ValueError):",
  "        return False",
  "    if abs(time.time() - timestamp) > tolerance:",
  "        return False",
  '    message = timestamps[0].encode() + b"." + raw_body',
  '    expected = hmac.new(secret.encode("utf-8"), message, hashlib.sha256).hexdigest().encode()',
  "    # bytes dos dois lados: compare_digest recusa str com caracteres fora do ASCII.",
  '    return any(hmac.compare_digest(expected, signature.encode("utf-8")) for signature in signatures)',
].join("\n");

/*
  Every number and name below is read from the constant that decides it —
  the retry schedule, the timeout, the scopes, the topics. This text is what
  an integrator sizes a reprocessing window and writes a receiver from, and
  "até seis horas" written by hand next to a schedule that adds up to seven
  had them one attempt short.

  Sections are `##` headings, not bold paragraphs: renderers build their
  navigation from headings, and a bold lead left the whole introduction as
  one block with no index.
*/

const PUBLIC_INFO = {
  title: "Trajetto — API de Integração",
  version: "v1",
  description: [
    "A API pública do Trajetto: documentos, rotas, eventos e webhooks.",
    "",
    "## Autenticação",
    "",
    "Envie a chave inteira, como foi entregue no cadastro,",
    "em `Authorization: Bearer tjk_live_<prefixo>.<segredo>`. O escopo de",
    "leitura e o de escrita são separados e um não implica o outro:",
    "`deliveries:write` cria entregas e não lê nenhuma.",
    `${reservedScopesPhrase((scope) => `\`${scope}\``)}: nenhum endpoint da v1`,
    `${RESERVED_API_SCOPES.length === 1 ? "o exige ainda, e ele não pode ser concedido" : "os exige ainda, e eles não podem ser concedidos"} a uma chave até que exista um.`,
    "",
    "Uma chave recusada responde 401 `INVALID_API_KEY` (ausente, malformada,",
    "desconhecida ou revogada, sem dizer qual); uma chave válida sem o escopo da",
    "rota responde 403 `MISSING_API_SCOPE`.",
    "",
    "## Criar entregas",
    "",
    "`POST /integration/v1/deliveries`, com o escopo",
    "`deliveries:write`, cria uma entrega por requisição (não há criação em",
    "lote na v1), com as mesmas regras e mensagens do cadastro manual do painel.",
    "O embarcador vem por `shipper_id` ou `shipper_cnpj`. Assinantes de",
    "`delivery.created` recebem o webhook da entrega criada.",
    "",
    "## Idempotência",
    "",
    "O cabeçalho `Idempotency-Key` é obrigatório nessa",
    "chamada: um valor por documento (um UUID, ou um valor derivado do seu",
    "documento, de 8 a 128 caracteres entre letras, números e `. _ : -`),",
    "repetido em toda nova tentativa do mesmo envio. Mesma chave e mesmo corpo",
    "devolvem 200 com a entrega já criada, sem duplicar nem avisar de novo;",
    "mesma chave com outro corpo é recusada com 409 `IDEMPOTENCY_KEY_REUSED`",
    "e o `delivery_id` da entrega que ela criou. A chave vale para a empresa",
    "inteira, entre todas as suas chaves de API e os cadastros feitos no",
    "painel: um valor que o painel já usou também recebe 409. Depois de um",
    "timeout, de um 500 ou de um 503, repita com a MESMA chave: é o que",
    "garante uma entrega só, mesmo que a primeira tentativa tenha sido gravada.",
    "A comparação é com a entrega como está gravada: se ela foi editada no",
    "painel, ou se o CNPJ do embarcador mudou e o envio o identifica por",
    "`shipper_cnpj`, repetir o corpo original também recebe 409 com o",
    "`delivery_id` para consultá-la.",
    "",
    "## Paginação e sincronização",
    "",
    "Por cursor, nunca por offset: um `next_cursor` sobrevive a",
    "documentos inseridos no meio da varredura, e um offset não — uma",
    "integração que pulou uma entrega porque outra chegou entre a página 12 e a",
    "13 perde documentos em silêncio. Passe o `next_cursor` da resposta em",
    "`cursor` até ele vir `null`. As listas vêm na ordem do `id`, crescente: o id",
    "é um UUID v7, então essa é a ordem de criação.",
    "",
    "Para buscar só o que mudou, anote o instante em que a varredura COMEÇA,",
    "percorra todas as páginas com `updated_since` igual ao início da varredura",
    "anterior e, ao terminar, guarde o início desta como o próximo",
    "`updated_since`. Desconte alguns minutos de margem para a diferença entre",
    'os relógios. O filtro é "maior ou igual" e um documento alterado durante a',
    "varredura volta na próxima: deduplique pelo `id` e fique com o",
    "`updated_at` mais recente. Em `/events`, `updated_since` compara com a hora",
    "em que o evento chegou ao Trajetto, não com `occurred_at`.",
    "",
    "## Erros",
    "",
    "Todo erro vem como JSON `{ code, message }`. O `code` é estável e é por ele",
    "que o seu código decide; a `message` é uma frase em português para mostrar",
    "a quem usa. No 400 `VALIDATION_ERROR` ela é a frase do primeiro campo",
    "recusado, e todas as frases, uma por campo, vêm em `issues`. Há duas",
    "exceções de texto fixo ou técnico: no 400 `MALFORMED_REQUEST` é o motivo",
    "do leitor de JSON, em inglês; no 500 `INTERNAL_ERROR` é",
    "`Internal server error`. Um 500 `INTERNAL_ERROR` e um",
    "503 `SERVICE_UNAVAILABLE` trazem `requestId`. Toda resposta, de sucesso ou",
    "de erro, traz o cabeçalho",
    "`x-request-id`: é o que o suporte pede para encontrar uma chamada.",
    "",
    "## Limites",
    "",
    "Cada chave tem um teto de requisições por minuto (`rate_limit_per_minute`),",
    "um só para todas as rotas somadas. O administrador da empresa define até",
    `${TENANT_API_KEY_RATE_CEILING} por minuto; acima disso, até ${PLATFORM_API_KEY_RATE_CEILING}, só o suporte. Todas as chaves`,
    `de uma empresa dividem ainda um teto de ${BUSINESS_API_RATE_PER_MINUTE} por minuto. Um endereço que`,
    `apresenta ${MAX_API_KEY_AUTH_FAILURES_PER_MINUTE} chaves inválidas num minuto é recusado pelo resto do`,
    "minuto. Passar de qualquer teto responde 429 `RATE_LIMITED` com o",
    "cabeçalho `retry-after`, em segundos: espere esse tempo antes de repetir.",
    "Com o banco de dados indisponível por instantes, a resposta é 503",
    `\`SERVICE_UNAVAILABLE\` com \`retry-after\` de ${DATABASE_RETRY_AFTER_SECONDS} s. Repita com espera`,
    "crescente, nunca em laço.",
    "",
    "## Webhooks",
    "",
    "Um POST `application/json` por evento, com o corpo",
    "`{ id, sequence, topic, created_at, data }` (schema `WebhookEnvelope`). Os",
    "cabeçalhos que enviamos:",
    "",
    "- `X-Trajetto-Event-Id`: o id do evento, igual ao `id` do corpo. É o mesmo",
    "  em toda retentativa e em todo reenvio manual.",
    "- `X-Trajetto-Delivery`: a tentativa. Muda num reenvio manual; serve para",
    "  falar com o suporte, não para deduplicar.",
    "- `X-Trajetto-Topic`: o tópico, igual ao `topic` do corpo.",
    "- `X-Trajetto-Signature`: a assinatura, descrita abaixo.",
    "",
    "## Entrega e deduplicação",
    "",
    "A entrega é pelo menos uma vez: o mesmo evento",
    "pode chegar de novo, por exemplo quando o seu servidor responde depois do",
    "nosso limite, quando o nosso processo cai entre a sua resposta e o nosso",
    "registro, ou quando alguém reenvia pelo painel. Deduplique pelo `id` do corpo",
    "(ou por `X-Trajetto-Event-Id`) antes de gravar. Esperamos a resposta por",
    `até ${WEBHOOK_TIMEOUT_MS / 1000} s, e qualquer 2xx é sucesso. Um 410 Gone`,
    "desliga o endpoint inteiro, não só aquele evento: para recusar um evento",
    "isolado, responda 2xx e ignore-o. Redirecionamento não é seguido: um 3xx",
    `conta como falha e também desliga o endpoint. ${MAX_CONSECUTIVE_FAILURES} falhas seguidas`,
    "desligam o endpoint até alguém religá-lo no painel. Enquanto ele está",
    `desligado, os eventos ficam guardados por até ${REPLAY_WINDOW_DAYS} dias e são enviados`,
    "quando o endpoint é reativado no painel — pelo botão Reativar ou quando é",
    "salvo ativo de novo. Pausar o endpoint no painel é",
    "cancelar a inscrição: os eventos gerados durante a pausa não são guardados,",
    "e só os que já estavam na fila esperam a reativação, pelo mesmo prazo.",
    "",
    "## Ordem",
    "",
    "Os eventos não chegam em ordem: são enviados em paralelo e uma",
    "retentativa chega depois de eventos mais novos. O campo `sequence` cresce,",
    "com lacunas, na ordem em que os eventos foram gerados e é o mesmo em toda",
    "retentativa e todo reenvio. Aplique um evento só se a `sequence` dele for",
    "maior que a do último evento que você aplicou ao mesmo documento ou rota.",
    "",
    "## Hora do fato",
    "",
    "O `created_at` do envelope é quando o evento foi gerado,",
    "não quando a entrega aconteceu. O aplicativo do motorista guarda o que foi",
    "feito sem sinal e envia depois, às vezes horas depois. Por isso",
    "`proof.registered`, o `delivery.delivered` que vem do canhoto e",
    "`occurrence.reported` trazem em `data.occurred_at` a hora do fato. Use-a para",
    "datar a entrega ou a ocorrência. Nos demais eventos, `occurred_at` é nulo e",
    "vale o `created_at`.",
    "",
    "## Assinatura",
    "",
    "O cabeçalho `X-Trajetto-Signature` traz",
    "`t=<timestamp>,v1=<hex>`. Calcule o HMAC SHA-256 sobre",
    '`timestamp + "." + corpo` com o segredo do endpoint e compare em tempo',
    "constante. A assinatura cobre o timestamp de propósito: uma assinatura só",
    "sobre o corpo é replayável para sempre.",
    "",
    "A chave do HMAC é o segredo INTEIRO, como o painel mostrou, com o prefixo",
    "`whsec_` incluído, em bytes UTF-8. Não remova o prefixo nem decodifique o",
    "resto em base64 (o costume de outras plataformas): a assinatura não confere.",
    "O corpo é o texto EXATO que chegou, antes de qualquer parse de JSON; um",
    "corpo reserializado muda a ordem ou os espaços e a assinatura não confere.",
    `Recuse um \`t\` com mais de ${SIGNATURE_TOLERANCE_SECONDS} s de diferença do seu relógio.`,
    "",
    "### Node.js",
    "",
    "```js",
    NODE_VERIFICATION_SAMPLE,
    "```",
    "",
    "### PHP",
    "",
    "```php",
    PHP_VERIFICATION_SAMPLE,
    "```",
    "",
    "### Python",
    "",
    "```python",
    PYTHON_VERIFICATION_SAMPLE,
    "```",
    "",
    "## Teste local",
    "",
    "Só enviamos para `https` alcançável pela internet: um",
    "endereço interno, `localhost` ou um IP privado é recusado no cadastro. Para",
    "testar na sua máquina, exponha o servidor local por um túnel https",
    "(cloudflared, ngrok ou similar) e cadastre a URL pública do túnel.",
    "",
    "## Troca de segredo",
    "",
    "O segredo pode ser trocado no painel sem perder",
    `eventos: durante as ${WEBHOOK_SECRET_ROTATION_GRACE_MS / 3_600_000} horas seguintes à troca, o cabeçalho traz dois \`v1\`,`,
    "`t=<timestamp>,v1=<novo>,v1=<anterior>`, um por segredo. Leia todos os `v1`",
    "e aceite a chamada se qualquer um conferir com o segredo que você tem. Troque",
    "o segredo do seu lado dentro desse prazo; depois dele, só o novo assina.",
    "",
    "## Retentativas",
    "",
    `Uma entrega que falha é repetida com intervalos de ${formatDelays(WEBHOOK_RETRY_DELAYS_MS)}:`,
    `até ${WEBHOOK_MAX_ATTEMPTS} tentativas ao longo de cerca de ${Math.round(
      WEBHOOK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) /
        3_600_000,
    )} horas. Depois disso o painel reenvia sob demanda, dentro de uma janela`,
    `de ${REPLAY_WINDOW_DAYS} dias.`,
    "",
    "## Inscrição",
    "",
    "Um endpoint assina nomes do catálogo ou curingas de um",
    `nível, que cobrem os tópicos com aquele prefixo: ${[...FAMILY_WILDCARDS.route, ...FAMILY_WILDCARDS.document].map((wildcard) => `\`${wildcard}\``).join(", ")}.`,
    `"Todos os eventos" de rotas é ${FAMILY_WILDCARDS.route.map((wildcard) => `\`${wildcard}\``).join(", ")};`,
    `de documentos, ${FAMILY_WILDCARDS.document.map((wildcard) => `\`${wildcard}\``).join(", ")}. Um curinga`,
    "assina também os tópicos que o prefixo ganhar depois. `*` puro não é aceito.",
    "",
    "## Tópicos",
    "",
    "O formato de `data` em cada um:",
    "",
    "| Tópico | Quando | `data` |",
    "| --- | --- | --- |",
    ...ALL_TOPICS.map(
      (topic) =>
        `| \`${topic}\` | ${TOPIC_DESCRIPTIONS[topic]} | \`${TOPIC_PAYLOAD[topic]}\` |`,
    ),
  ].join("\n"),
};

/**
 * Keeps the paths under the public prefix and the security scheme they use,
 * then finishes the document for readers (public-docs-reference: OpenAPI 3.1,
 * webhooks, tags per resource, servers, the `x-trajetto-*` numbers).
 *
 * `components.schemas` is carried over untouched rather than pruned: the zod
 * transformer inlines most shapes, and a prune that guessed wrong would ship a
 * document with a dangling `$ref` — a reference that renders as an empty box
 * and tells the reader nothing about what to send.
 */
const COMPONENT_REF = /^#\/components\/([^/]+)\/(.+)$/;

/**
 * The components the public paths and the webhook payloads reach through
 * `$ref`, transitively — and nothing else.
 *
 * Copying every component of the internal document would publish the shape
 * of any internal schema registered with an `$id` (a user, a permission, a
 * master-only report) the day somebody registers one. Reachability is
 * deterministic, so no shape a public path needs can be pruned by mistake.
 * `securitySchemes` is filtered on its own (the session scheme never ships).
 */
function reachableComponents(
  components: Record<string, unknown>,
  roots: unknown[],
): Record<string, Record<string, unknown>> {
  const kept: Record<string, Record<string, unknown>> = {};
  const pending = [...roots];
  const seen = new Set<unknown>();

  while (pending.length > 0) {
    const node = pending.pop();

    if (!node || typeof node !== "object" || seen.has(node)) continue;

    seen.add(node);

    for (const [key, value] of Object.entries(
      node as Record<string, unknown>,
    )) {
      if (key === "$ref" && typeof value === "string") {
        const match = COMPONENT_REF.exec(value);

        if (!match) continue;

        const [, section, name] = match;
        const target = (
          components[section] as Record<string, unknown> | undefined
        )?.[name];

        if (target === undefined || section === "securitySchemes") continue;

        kept[section] = { ...(kept[section] ?? {}), [name]: target };
        pending.push(target);
      } else if (value && typeof value === "object") {
        pending.push(value);
      }
    }
  }

  return kept;
}

function buildPublicApiDocument(
  source: OpenApiDocument,
  options: PublicDocsOptions = publicDocsOptionsFromEnv(),
): OpenApiDocument {
  const paths = Object.fromEntries(
    Object.entries(source.paths ?? {}).filter(([path]) =>
      path.startsWith(PUBLIC_PREFIX),
    ),
  );

  const components = (source.components ?? {}) as {
    securitySchemes?: Record<string, unknown>;
    [key: string]: unknown;
  };

  const securitySchemes = components.securitySchemes ?? {};

  // What a webhook carries. No path refers to these — a webhook is a request
  // WE make — so they sit next to the endpoints' shapes and the topic table
  // in the description points at them by name.
  const reachable = reachableComponents(
    {
      ...components,
      schemas: {
        ...((components.schemas as Record<string, unknown> | undefined) ?? {}),
        ...WEBHOOK_PAYLOAD_SCHEMAS,
      },
    },
    [paths, WEBHOOK_PAYLOAD_SCHEMAS],
  );

  return finishPublicDocument(
    {
      openapi: source.openapi ?? "3.1.0",
      info: PUBLIC_INFO,

      ...(source.servers ? { servers: source.servers } : {}),

      paths,

      components: {
        ...reachable,

        schemas: {
          ...(reachable.schemas ?? {}),
          ...WEBHOOK_PAYLOAD_SCHEMAS,
        },

        // The session scheme is dropped: a public reference that offers
        // "bearerAuth (JWT)" invites an integrator to try logging in as a
        // person, which is the one thing this surface does not do.
        securitySchemes: Object.fromEntries(
          Object.entries(securitySchemes).filter(([name]) => name === "apiKey"),
        ),
      },

      // Replaced by one tag per resource in finishPublicDocument.
      tags: [],
    },
    options,
  ) as OpenApiDocument;
}

// The renderer's pinned script and its configuration: public-docs-console.

/**
 * Shows the fallback when the renderer fails to load or fails its integrity
 * check.
 *
 * A capturing listener on window instead of an `onerror` attribute: the
 * page's CSP forbids inline handlers (`script-src-attr 'none'`), which is what
 * kept the fallback hidden on a page that was already blank. It runs before
 * the renderer's tag, because a load error fires once.
 */
const DOCS_FALLBACK_SCRIPT =
  "window.addEventListener('error',function(e){var t=e.target;" +
  "if(t&&t.id==='api-reference'){document.getElementById('fallback').hidden=false;}},true);";

/**
 * The CSP of the portal page, and of no other route.
 *
 * Merged over helmet's defaults, so everything else stays as strict as the
 * rest of the API. The inline fallback is allowed by its hash rather than by
 * a nonce: the page is cached publicly for five minutes, and a nonce is only
 * worth something when every response carries a new one.
 */
const PUBLIC_DOCS_CSP_DIRECTIVES = {
  "script-src": [
    "'self'",
    "https://cdn.jsdelivr.net",
    `'sha256-${createHash("sha256").update(DOCS_FALLBACK_SCRIPT).digest("base64")}'`,
  ],
  "connect-src": ["'self'"],
};

/**
 * The portal itself, as one HTML string.
 *
 * Scalar from a CDN rather than bundled: the image was deliberately slimmed
 * and a documentation renderer is not worth putting back into it. The page
 * degrades to a link to the raw JSON if the script does not load, because a
 * blank page would have integrators emailing support about an outage that is
 * only their corporate proxy.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderPublicDocsPage(
  specUrl: string,
  options: PublicDocsOptions = publicDocsOptionsFromEnv(),
): string {
  // The guides live on the web portal; both fallbacks point there too.
  const guides = options.portalUrl
    ? ` Os guias em português estão em <a href="${escapeHtml(options.portalUrl)}">${escapeHtml(options.portalUrl)}</a>.`
    : "";

  // Only production's console belongs in search results; staging runs the
  // same image and would otherwise compete with it.
  const robots =
    options.environment && options.environment !== "production"
      ? '\n    <meta name="robots" content="noindex, nofollow" />'
      : "";

  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />${robots}
    <title>Trajetto — API de Integração</title>
    <style>
      body { margin: 0; font-family: system-ui, sans-serif; }
      .fallback { padding: 2rem; max-width: 40rem; margin: 0 auto; }
    </style>
  </head>
  <body>
    <noscript class="fallback">
      <h1>Trajetto — API de Integração</h1>
      <p>
        Esta página usa JavaScript para renderizar a referência.
        O documento OpenAPI está em <a href="${specUrl}">${specUrl}</a>.${guides}
      </p>
    </noscript>

    <div id="fallback" class="fallback" hidden>
      <h1>Trajetto — API de Integração</h1>
      <p>
        Não foi possível carregar o renderizador da documentação.
        O documento OpenAPI está em <a href="${specUrl}">${specUrl}</a>.${guides}
      </p>
    </div>

    <script>${DOCS_FALLBACK_SCRIPT}</script>

    <script
      id="api-reference"
      data-url="${specUrl}"
      data-configuration="${scalarConfigurationAttribute()}"
      src="${SCALAR_SCRIPT.src}"
      integrity="${SCALAR_SCRIPT.integrity}"
      crossorigin="anonymous"
    ></script>
  </body>
</html>`;
}

/** The console's path, the one page on this host meant for search. */
const PUBLIC_DOCS_PATH = "/integration/docs";

/**
 * The API host's robots.txt. Only the public console, and the OpenAPI
 * document it renders from (same prefix), is meant for search, and only in
 * production: staging runs the same image and stays out entirely.
 *
 * Cloudflare prepends its managed block to whatever the origin serves, and
 * that block says `Allow: /` to every crawler. Crawlers take the longest
 * matching rule and, on a tie, the least restrictive one, so a bare
 * `Disallow: /` would lose to it; `Disallow: /*` is longer, and the console's
 * `Allow` longer still.
 */
function renderApiRobotsTxt(
  options: PublicDocsOptions = publicDocsOptionsFromEnv(),
): string {
  if (options.environment !== "production") {
    return "User-agent: *\nDisallow: /*\n";
  }

  const sitemap = options.serverUrl
    ? `\nSitemap: ${options.serverUrl}/sitemap.xml\n`
    : "";

  return `User-agent: *\nAllow: ${PUBLIC_DOCS_PATH}\nDisallow: /*\n${sitemap}`;
}

/**
 * The API host's sitemap: the console alone, in production, on the API's own
 * origin (a sitemap may only list URLs of its host, so the web's cannot). No
 * lastmod: the page follows the live API, and a date that always says
 * "today" teaches Google to ignore the field. Null where there is none.
 */
function renderApiSitemapXml(
  options: PublicDocsOptions = publicDocsOptionsFromEnv(),
): string | null {
  if (options.environment !== "production" || !options.serverUrl) return null;

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${escapeHtml(options.serverUrl)}${PUBLIC_DOCS_PATH}</loc>
  </url>
</urlset>
`;
}

export {
  NODE_VERIFICATION_SAMPLE,
  PHP_VERIFICATION_SAMPLE,
  PYTHON_VERIFICATION_SAMPLE,
  PUBLIC_DOCS_CSP_DIRECTIVES,
  PUBLIC_DOCS_PATH,
  PUBLIC_PREFIX,
  buildPublicApiDocument,
  renderApiRobotsTxt,
  renderApiSitemapXml,
  renderPublicDocsPage,
  type OpenApiDocument,
};
