/**
 * The base map the clients draw under the fleet (wave 5, the app's live map).
 *
 * The web reads its provider from MAP_TILE_URL on its own server
 * (trajetto-ui/src/features/control-tower/lib/map-tiles.ts, decisions 7.4 and
 * 16.123). The app ships by OTA as a JavaScript bundle: a provider URL inlined
 * there hands its key to anyone who unpacks the APK, and changing it takes
 * another bundle. So the API holds the same four variables (the owner copies
 * the web's values into its Environment) and GET /config/map hands them to a
 * signed-in client.
 *
 * The rules are the web's, one by one, so both clients agree on what
 * "configured" means:
 * - a template is https (http only in development) with {z}, {x} and {y};
 *   {s} and the other lowercase slots Leaflet fills are allowed;
 * - the credit is plain text in the environment and leaves escaped, because
 *   Leaflet writes it as HTML: an environment value never becomes markup;
 * - the public OpenStreetMap servers are the fallback in development only
 *   (their tile policy forbids 3.600 companies' worth of load);
 * - no base map, no dark one; the dark credit falls back to the base's.
 *
 * Two deliberate differences:
 * - the development OSM credit is plain text, not the web's link. The app's
 *   WebView blocks navigation, and a credit that is never markup lets the
 *   app refuse any tag it receives;
 * - the template also passes the app's own check (`TEMPLATE_HEAD` below),
 *   stricter than the web's. The app's page lets images in from the tiles'
 *   one origin only, so it refuses a template whose host its CSP cannot
 *   name that way and draws no base map. Served anyway, the manager would
 *   read "Mapa de fundo não configurado" with the variable set; refused
 *   here, the boot names the variable instead.
 *
 * Pure on purpose: the env schema validates the variables with these same
 * functions, and it is parsed before anything can import `@/env`.
 */

type MapAppEnv = "development" | "staging" | "production";

interface MapTileSource {
  /** A Leaflet template: {z}, {x}, {y}, optionally {s} and {r}. */
  url: string;
  /** The provider's credit, HTML-escaped plain text. */
  attribution: string;
}

interface MapTiles extends MapTileSource {
  /** The provider's dark style; absent when not configured (CSS filter then). */
  dark?: MapTileSource;
}

interface MapTileSettings {
  url?: string | null;
  attribution?: string | null;
  darkUrl?: string | null;
  darkAttribution?: string | null;
  appEnv: MapAppEnv;
}

const OSM_TILES: MapTiles = {
  url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution: "© colaboradores do OpenStreetMap",
};

const DEFAULT_ATTRIBUTION = "© provedor de mapas";

const OSM_TILE_HOST = "tile.openstreetmap.org";

/** A template is a URL; past this it is not one a provider hands out. */
const TEMPLATE_MAX_LENGTH = 1024;

/**
 * The app's reading of a template's head (trajetto-mobile
 * features/live-map/map-config-rules.ts, TEMPLATE_HEAD), copied as is: the
 * host is letters, digits and hyphens, dot by dot, optionally led by the
 * subdomain slot with at least two labels after it (`{s}.tile.example.com`,
 * never `{s}.com` nor a bare `{s}`), then an optional port. No credentials,
 * no wildcard, no other slot in the host, no IPv6 literal, no underscore,
 * no trailing dot: what the WHATWG parser below would let through.
 */
const TEMPLATE_HEAD =
  /^(https?):\/\/((?:\{s\}\.(?=[a-z0-9-]+\.[a-z0-9-]))?[a-z0-9-]+(?:\.[a-z0-9-]+)*)(:\d{1,5})?(?=[/?#])/i;

/** What the app refuses anywhere in a template: it rides in a JSON string. */
const TEMPLATE_FORBIDDEN = /[\s"'<>\\`*]/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** The template as a URL, every slot filled with a stand-in; null if broken. */
function parseTemplate(value: string): URL | null {
  try {
    // The subdomain slot is not a valid host character; any stand-in is.
    return new URL(value.replace(/\{s\}/g, "a").replace(/\{[a-z]+\}/g, "0"));
  } catch {
    return null;
  }
}

/**
 * A usable template: https (http only in development) with the tile axes,
 * and one the app takes too (its length, characters and head).
 */
function isTileTemplate(value: string, appEnv: MapAppEnv): boolean {
  if (value.length > TEMPLATE_MAX_LENGTH || TEMPLATE_FORBIDDEN.test(value)) {
    return false;
  }

  if (!/\{z\}/.test(value) || !/\{x\}/.test(value) || !/\{y\}/.test(value)) {
    return false;
  }

  if (!TEMPLATE_HEAD.test(value)) return false;

  const url = parseTemplate(value);

  return (
    url !== null &&
    (url.protocol === "https:" ||
      (appEnv === "development" && url.protocol === "http:"))
  );
}

/** Whether a template points at the public OSM tile servers. */
function isPublicOsmTemplate(value: string): boolean {
  const host = parseTemplate(value)?.hostname;

  return (
    host !== undefined &&
    (host === OSM_TILE_HOST || host.endsWith(`.${OSM_TILE_HOST}`))
  );
}

/**
 * The dark style, when MAP_TILE_URL_DARK is a usable template. Its credit
 * falls back to the base map's: a dark style of the same provider is the
 * usual case, and that credit names the provider.
 */
function resolveDarkTiles(
  settings: MapTileSettings,
  base: MapTileSource,
): MapTileSource | undefined {
  const url = settings.darkUrl?.trim();

  if (!url || !isTileTemplate(url, settings.appEnv)) return undefined;

  const credit = settings.darkAttribution?.trim();

  return { url, attribution: credit ? escapeHtml(credit) : base.attribution };
}

function resolveMapTiles(settings: MapTileSettings): MapTiles | null {
  const url = settings.url?.trim();
  const base: MapTiles | null =
    url && isTileTemplate(url, settings.appEnv)
      ? {
          url,
          attribution: escapeHtml(
            settings.attribution?.trim() || DEFAULT_ATTRIBUTION,
          ),
        }
      : settings.appEnv === "development"
        ? OSM_TILES
        : null;

  // No base map, no dark one either: the clients say "sem mapa de fundo".
  const dark = base ? resolveDarkTiles(settings, base) : undefined;

  return base && dark ? { ...base, dark } : base;
}

/** The settings as the parsed environment holds them. */
function mapTileSettingsFrom(env: {
  MAP_TILE_URL?: string;
  MAP_TILE_ATTRIBUTION?: string;
  MAP_TILE_URL_DARK?: string;
  MAP_TILE_ATTRIBUTION_DARK?: string;
  APP_ENV: MapAppEnv;
}): MapTileSettings {
  return {
    url: env.MAP_TILE_URL,
    attribution: env.MAP_TILE_ATTRIBUTION,
    darkUrl: env.MAP_TILE_URL_DARK,
    darkAttribution: env.MAP_TILE_ATTRIBUTION_DARK,
    appEnv: env.APP_ENV,
  };
}

export {
  DEFAULT_ATTRIBUTION,
  OSM_TILES,
  TEMPLATE_MAX_LENGTH,
  isPublicOsmTemplate,
  isTileTemplate,
  mapTileSettingsFrom,
  resolveMapTiles,
};
export type { MapAppEnv, MapTileSettings, MapTileSource, MapTiles };
