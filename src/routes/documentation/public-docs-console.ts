/**
 * The interactive console at /integration/docs: Scalar, pinned and configured.
 *
 * The web portal (/docs on the web app) holds the guides and a reference
 * rendered on the server; this page stays as the place to try a call with a
 * key (decision 11.2). Everything it loads is pinned here.
 */

/**
 * The renderer, pinned by version AND by bytes.
 *
 * `standalone.js` is the file npm published, so it is immutable for the
 * version; `standalone.min.js` would be a copy jsDelivr minifies on its own,
 * whose bytes the package does not fix — the wrong thing to pin a hash on.
 * The integrity is the SHA-384 of that file; its SHA-256 matched the one
 * jsDelivr lists (data.jsdelivr.com/v1/packages/npm/@scalar/api-reference@1.72.1).
 * Bumping the version means recomputing it:
 * `curl -sL <src> | openssl dgst -sha384 -binary | openssl base64 -A`.
 */
const SCALAR_VERSION = "1.72.1";

const SCALAR_SCRIPT = {
  src: `https://cdn.jsdelivr.net/npm/@scalar/api-reference@${SCALAR_VERSION}/dist/browser/standalone.js`,
  integrity:
    "sha384-U11tb2XnKvmwt8RlTvnwUnYgrN+ur4Xyh9htLhjajWNR/Oyl5AX5DEz00qRmlrmK",
};

/**
 * What the page asks of the renderer.
 *
 * - No default fonts: they come from a Scalar host the page's CSP was never
 *   meant to trust; the system font is enough.
 * - Portuguese interface (the renderer ships a Portuguese locale).
 * - No proxy and no stored credentials: requests go straight to `servers`
 *   (same origin, `connect-src 'self'`), and a key typed here is not written
 *   to the browser's storage.
 * - No AI assistant, MCP generator, telemetry or developer toolbar: none of
 *   them has a place on a page an integrator pastes a production key into.
 *
 * The only CSP report the page produces is `script-src eval` from the zod
 * bundled in the renderer, which probes `Function("")` once and falls back
 * to its non-JIT path when refused: expected, and not worth an 'unsafe-eval'.
 */
const SCALAR_CONFIGURATION = {
  layout: "modern",
  theme: "default",
  withDefaultFonts: false,
  localization: { locale: "pt-BR" },
  metaData: {
    title: "Console da API de Integração | Trajetto",
    description:
      "Referência interativa da API de Integração do Trajetto: entregas, rotas, eventos e webhooks.",
  },
  documentDownloadType: "json",
  // The key scheme is the only one the document offers; preselected so the
  // console asks for the key instead of "no authentication selected".
  authentication: { preferredSecurityScheme: "apiKey" },
  persistAuth: false,
  telemetry: false,
  agent: { disabled: true },
  mcp: { disabled: true },
  showDeveloperTools: "never",
  defaultHttpClient: { targetKey: "shell", clientKey: "curl" },
  customCss:
    ".light-mode { --scalar-color-accent: #d81b60; } .dark-mode { --scalar-color-accent: #ff4081; }",
} as const;

/** The configuration as an HTML attribute value (the renderer JSON-parses it). */
function scalarConfigurationAttribute(): string {
  return JSON.stringify(SCALAR_CONFIGURATION)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export {
  SCALAR_CONFIGURATION,
  SCALAR_SCRIPT,
  SCALAR_VERSION,
  scalarConfigurationAttribute,
};
