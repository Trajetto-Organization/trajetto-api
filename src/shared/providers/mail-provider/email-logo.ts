import { env } from "@/env";

/**
 * Where the API serves the logo every e-mail shows (src/routes/asset-routes.ts).
 * The bytes are assets/proof/trajetto-logo.png, embedded in the bundle.
 */
const EMAIL_LOGO_PATH = "/assets/trajetto-logo.png";

/**
 * The absolute URL of the e-mail logo under `apiUrl`, or nothing without one.
 */
function buildEmailLogoUrl(apiUrl: string | undefined): string | undefined {
  const base = apiUrl?.trim().replace(/\/+$/, "");

  return base ? `${base}${EMAIL_LOGO_PATH}` : undefined;
}

/**
 * The e-mail logo URL, built from the API's public address.
 *
 * A mail client fetches it from outside, so API_HTTP_REQUEST must be the
 * PUBLIC URL of this API. Without it there is nothing to point at: the logo
 * is left out and the e-mail goes without it.
 */
function emailLogoUrl(): string | undefined {
  return buildEmailLogoUrl(env.API_HTTP_REQUEST);
}

export { EMAIL_LOGO_PATH, buildEmailLogoUrl, emailLogoUrl };
