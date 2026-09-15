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

const PUBLIC_INFO = {
  title: "Trajetto — API de Integração",
  version: "v1",
  description: [
    "A API pública do Trajetto: documentos, rotas, eventos e webhooks.",
    "",
    "**Autenticação.** Envie a chave inteira, como foi entregue no cadastro,",
    "em `Authorization: Bearer tjk_live_<prefixo>.<segredo>`. O escopo de",
    "leitura e o de escrita são separados e um não implica o outro.",
    "",
    "**Paginação.** Por cursor, nunca por offset: um `next_cursor` sobrevive a",
    "documentos inseridos no meio da varredura, e um offset não — uma",
    "integração que pulou uma entrega porque outra chegou entre a página 12 e a",
    "13 perde documentos em silêncio.",
    "",
    "**Webhooks.** O cabeçalho `X-Trajetto-Signature` traz",
    "`t=<timestamp>,v1=<hex>`. Calcule o HMAC SHA-256 sobre",
    "`timestamp + \".\" + corpo` com o segredo do endpoint e compare em tempo",
    "constante. A assinatura cobre o timestamp de propósito: uma assinatura só",
    "sobre o corpo é replayável para sempre.",
    "",
    "**Reenvio.** Repetimos uma entrega falha por até seis horas. Depois disso",
    "o painel reenvia sob demanda, dentro de uma janela de 30 dias.",
  ].join("\n"),
};

/**
 * Keeps the paths under the public prefix and the security scheme they use.
 *
 * `components.schemas` is carried over untouched rather than pruned: the zod
 * transformer inlines most shapes, and a prune that guessed wrong would ship a
 * document with a dangling `$ref` — a reference that renders as an empty box
 * and tells the reader nothing about what to send.
 */
function buildPublicApiDocument(source: OpenApiDocument): OpenApiDocument {
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

  return {
    openapi: source.openapi ?? "3.1.0",
    info: PUBLIC_INFO,

    ...(source.servers ? { servers: source.servers } : {}),

    paths,

    components: {
      ...components,

      // The session scheme is dropped: a public reference that offers
      // "bearerAuth (JWT)" invites an integrator to try logging in as a
      // person, which is the one thing this surface does not do.
      securitySchemes: Object.fromEntries(
        Object.entries(securitySchemes).filter(([name]) => name === "apiKey"),
      ),
    },

    tags: [
      {
        name: "integration",
        description: "Documentos, rotas e eventos, autenticados por chave.",
      },
    ],
  };
}

/**
 * The portal itself, as one HTML string.
 *
 * Scalar from a CDN rather than bundled: the image was deliberately slimmed
 * and a documentation renderer is not worth putting back into it. The page
 * degrades to a link to the raw JSON if the script does not load, because a
 * blank page would have integrators emailing support about an outage that is
 * only their corporate proxy.
 */
function renderPublicDocsPage(specUrl: string): string {
  return `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
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
        O documento OpenAPI está em <a href="${specUrl}">${specUrl}</a>.
      </p>
    </noscript>

    <div id="fallback" class="fallback" hidden>
      <h1>Trajetto — API de Integração</h1>
      <p>
        Não foi possível carregar o renderizador da documentação.
        O documento OpenAPI está em <a href="${specUrl}">${specUrl}</a>.
      </p>
    </div>

    <script
      id="api-reference"
      data-url="${specUrl}"
      src="https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.25.0/dist/browser/standalone.min.js"
      onerror="document.getElementById('fallback').hidden = false"
    ></script>
  </body>
</html>`;
}

export {
  PUBLIC_PREFIX,
  buildPublicApiDocument,
  renderPublicDocsPage,
  type OpenApiDocument,
};
