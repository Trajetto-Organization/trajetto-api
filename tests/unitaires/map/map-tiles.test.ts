import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";
import {
  DEFAULT_ATTRIBUTION,
  OSM_TILES,
  TEMPLATE_MAX_LENGTH,
  isPublicOsmTemplate,
  isTileTemplate,
  mapTileSettingsFrom,
  resolveMapTiles,
} from "@/shared/map/map-tiles";

/**
 * The app's base map (wave 5), ported from the web's map-tiles.ts so both
 * clients agree on what "configured" means: the template rules, the escaped
 * credit, public OSM in development only, and the dark style's fallbacks.
 * The provider URL may carry its key, so the boot refuses a broken one by
 * name and never echoes the value.
 */

const LIGHT =
  "https://{s}.tiles.example.test/light/{z}/{x}/{y}{r}.png?key=tile-secret";
const DARK = "https://dark.example.test/{z}/{x}/{y}.png?key=dark-secret";

describe("resolveMapTiles", () => {
  it("serves the configured provider with its credit escaped", () => {
    expect(
      resolveMapTiles({
        url: `  ${LIGHT} `,
        attribution: ` © Exemplo <b>&"'`,
        appEnv: "production",
      }),
    ).toEqual({
      url: LIGHT,
      attribution: "© Exemplo &lt;b&gt;&amp;&quot;&#39;",
    });
  });

  it("credits a generic provider when no credit is set", () => {
    expect(
      resolveMapTiles({ url: LIGHT, attribution: "  ", appEnv: "staging" })
        ?.attribution,
    ).toBe(DEFAULT_ATTRIBUTION);
  });

  it("falls back to public OSM in development only", () => {
    // The same object, as on the web.
    expect(resolveMapTiles({ appEnv: "development" })).toBe(OSM_TILES);
    expect(resolveMapTiles({ appEnv: "staging" })).toBeNull();
    expect(resolveMapTiles({ appEnv: "production" })).toBeNull();

    // A broken template counts as unset: OSM in development, nothing elsewhere.
    expect(
      resolveMapTiles({ url: "https://x.test/tiles", appEnv: "development" }),
    ).toBe(OSM_TILES);
    expect(
      resolveMapTiles({ url: "https://x.test/tiles", appEnv: "production" }),
    ).toBeNull();
  });

  it("keeps the development credit plain text, never markup", () => {
    expect(OSM_TILES.attribution).not.toMatch(/[<>]/);
  });

  it("carries the dark style with its own credit, escaped", () => {
    expect(
      resolveMapTiles({
        url: LIGHT,
        attribution: "© Claro",
        darkUrl: DARK,
        darkAttribution: "© Escuro <i>",
        appEnv: "production",
      }),
    ).toEqual({
      url: LIGHT,
      attribution: "© Claro",
      dark: { url: DARK, attribution: "© Escuro &lt;i&gt;" },
    });
  });

  it("falls back to the light credit for the dark style", () => {
    expect(
      resolveMapTiles({
        url: LIGHT,
        attribution: "© A & B",
        darkUrl: DARK,
        darkAttribution: " ",
        appEnv: "production",
      })?.dark,
    ).toEqual({ url: DARK, attribution: "© A &amp; B" });

    // In development the base is OSM, and so is the dark style's credit.
    expect(resolveMapTiles({ darkUrl: DARK, appEnv: "development" })).toEqual({
      ...OSM_TILES,
      dark: { url: DARK, attribution: OSM_TILES.attribution },
    });
  });

  it("leaves no dark key when it is unset or broken, so the client keeps the filter", () => {
    for (const darkUrl of [
      undefined,
      "",
      "http://dark.example.test/{z}/{x}/{y}",
    ]) {
      const tiles = resolveMapTiles({ url: LIGHT, darkUrl, appEnv: "staging" });

      expect(tiles && Object.keys(tiles).sort()).toEqual([
        "attribution",
        "url",
      ]);
    }
  });

  it("drops the dark style without a base map", () => {
    expect(resolveMapTiles({ darkUrl: DARK, appEnv: "production" })).toBeNull();
  });
});

describe("isTileTemplate", () => {
  it.each([
    ["https with the three axes", LIGHT, "production", true],
    ["https without a subdomain slot", DARK, "staging", true],
    [
      "http in development",
      "http://localhost:8080/{z}/{x}/{y}.png",
      "development",
      true,
    ],
    [
      "http in staging",
      "http://tiles.example.test/{z}/{x}/{y}.png",
      "staging",
      false,
    ],
    [
      "http in production",
      "http://tiles.example.test/{z}/{x}/{y}.png",
      "production",
      false,
    ],
    [
      "without {z}",
      "https://tiles.example.test/{x}/{y}.png",
      "production",
      false,
    ],
    [
      "without {x}",
      "https://tiles.example.test/{z}/{y}.png",
      "production",
      false,
    ],
    [
      "without {y}",
      "https://tiles.example.test/{z}/{x}.png",
      "production",
      false,
    ],
    [
      "another scheme",
      "ftp://tiles.example.test/{z}/{x}/{y}.png",
      "development",
      false,
    ],
    ["javascript:", "javascript:alert(1)//{z}{x}{y}", "development", false],
    ["not a URL", "tiles {z} {x} {y}", "development", false],
  ] as const)("%s", (_label, value, appEnv, expected) => {
    expect(isTileTemplate(value, appEnv)).toBe(expected);
  });
});

/**
 * The app's own template check (trajetto-mobile
 * features/live-map/map-config-rules.ts), one row per case its tests pin.
 * Its page lets images in from the tiles' one origin only, so it refuses a
 * template whose host its CSP cannot name that way, and then draws no base
 * map. The API took them all (the web's rule parses with WHATWG URL, which
 * accepts `*`, a bare host, credentials, IPv6, quotes...): it booted and
 * served them, and the manager read "Mapa de fundo não configurado" with
 * the variable set. Now the API refuses what the app refuses, so a bad
 * value stops the boot by name instead. The web's real templates (MapTiler
 * with and without {r}, a {s} subdomain) still pass.
 */
const AT_LIMIT = (() => {
  const head = "https://tiles.example.com/";
  const tail = "/{z}/{x}/{y}.png";

  return `${head}${"a".repeat(TEMPLATE_MAX_LENGTH - head.length - tail.length)}${tail}`;
})();

const APP_PARITY = [
  [
    "MapTiler",
    "https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=k",
    "production",
    true,
  ],
  [
    "MapTiler with {r}",
    "https://api.maptiler.com/maps/streets-v2/256/{z}/{x}/{y}{r}.png?key=k",
    "production",
    true,
  ],
  [
    "a {s} subdomain",
    "https://{s}.tile.example.com/{z}/{x}/{y}.png",
    "production",
    true,
  ],
  [
    "{s} on a two-label host",
    "https://{s}.a.com/{z}/{x}/{y}.png",
    "production",
    true,
  ],
  [
    "{s} and {r} with a key",
    "https://{s}.tiles.example.com/{z}/{x}/{y}{r}.png?key=abc",
    "staging",
    true,
  ],
  [
    "a port",
    "https://tiles.example.com:8443/{z}/{x}/{y}.png",
    "production",
    true,
  ],
  [
    "upper case scheme and host",
    "HTTPS://{s}.Tiles.Example.com/{z}/{x}/{y}.png",
    "production",
    true,
  ],
  [
    "public OSM in development",
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    "development",
    true,
  ],
  [
    "a local server in development",
    "http://localhost:8080/{z}/{x}/{y}.png",
    "development",
    true,
  ],
  ["exactly the length limit", AT_LIMIT, "production", true],
  [
    "a local server outside development",
    "http://localhost:8080/{z}/{x}/{y}.png",
    "staging",
    false,
  ],
  ["a wildcard host", "https://*/{z}/{x}/{y}.png", "production", false],
  [
    "a wildcard subdomain",
    "https://*.example.com/{z}/{x}/{y}.png",
    "production",
    false,
  ],
  [
    "a wildcard in the query",
    "https://tiles.example.com/{z}/{x}/{y}.png?k=*",
    "production",
    false,
  ],
  ["a bare {s} host", "https://{s}/{z}/{x}/{y}", "production", false],
  [
    "{s} straight on a top-level domain",
    "https://{s}.com/{z}/{x}/{y}.png",
    "production",
    false,
  ],
  [
    "{s} inside a label",
    "https://tiles-{s}.example.com/{z}/{x}/{y}.png",
    "production",
    false,
  ],
  [
    "{r} in the host",
    "https://tiles{r}.example.com/{z}/{x}/{y}.png",
    "production",
    false,
  ],
  [
    "credentials",
    "https://user:pass@tiles.example.com/{z}/{x}/{y}.png",
    "production",
    false,
  ],
  ["an IPv6 literal", "https://[::1]/{z}/{x}/{y}.png", "development", false],
  [
    "a double quote",
    'https://tiles.example.com/{z}/{x}/{y}.png"onload="x',
    "production",
    false,
  ],
  [
    "a single quote",
    "https://tiles.example.com/{z}/{x}/{y}.png'",
    "production",
    false,
  ],
  [
    "a tag",
    "https://tiles.example.com/{z}/{x}/{y}.png</script>",
    "production",
    false,
  ],
  [
    "a space",
    "https://tiles.example.com/{z}/{x}/{y} .png",
    "production",
    false,
  ],
  [
    "a backslash",
    "https://tiles.example.com/{z}/{x}/{y}\\.png",
    "production",
    false,
  ],
  [
    "a backtick",
    "https://tiles.example.com/{z}/{x}/{y}`.png",
    "production",
    false,
  ],
  [
    "a trailing dot on the host",
    "https://tiles.example.com./{z}/{x}/{y}.png",
    "production",
    false,
  ],
  [
    "an underscore in the host",
    "https://tiles_a.example.com/{z}/{x}/{y}.png",
    "production",
    false,
  ],
  [
    "over the length limit",
    `https://tiles.example.com/${"a".repeat(1100)}/{z}/{x}/{y}.png`,
    "production",
    false,
  ],
] as const;

describe("isTileTemplate, in parity with the app's check", () => {
  it.each(APP_PARITY)("%s", (_label, value, appEnv, expected) => {
    expect(isTileTemplate(value, appEnv)).toBe(expected);
  });

  it("measures the limit as the app does: 1024 characters pass, one more does not", () => {
    expect(AT_LIMIT).toHaveLength(TEMPLATE_MAX_LENGTH);
    expect(TEMPLATE_MAX_LENGTH).toBe(1024);
    expect(isTileTemplate(`${AT_LIMIT}a`, "production")).toBe(false);
  });

  it("never serves a refused template from GET /config/map, light or dark", () => {
    for (const [label, value, appEnv, expected] of APP_PARITY) {
      if (expected) continue;

      expect(resolveMapTiles({ url: value, appEnv }), label).toBe(
        appEnv === "development" ? OSM_TILES : null,
      );
      expect(
        resolveMapTiles({ url: LIGHT, darkUrl: value, appEnv })?.dark,
        label,
      ).toBeUndefined();
    }
  });
});

/**
 * The same table against the app's real function, read from the sibling
 * checkout when it is there (as client-routes.test.ts reads what the app
 * calls): a rule tightened in the app alone shows up here, not as a map
 * with no background in the field.
 */
const APP_MAP_CONFIG_RULES = resolve(
  process.cwd(),
  "..",
  "trajetto-mobile",
  "features/live-map/map-config-rules.ts",
);

describe.skipIf(!existsSync(APP_MAP_CONFIG_RULES))(
  "the parity table against trajetto-mobile",
  () => {
    // CI checks the app out with no node_modules, and transforming the file
    // where it lies reads the app's tsconfig.json, whose `extends`
    // (expo/tsconfig.base) is in them: the import failed on every push to
    // staging, a red that was the checkout's, not the code's. A copy outside
    // any project is transformed on its own; the one import the file has is
    // a type, erased with it, and a runtime import added there fails here,
    // loudly.
    let dir: string | undefined;

    afterAll(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it("imports nothing at runtime, so the copy runs as the app's own file", () => {
      expect(readFileSync(APP_MAP_CONFIG_RULES, "utf8")).not.toMatch(
        /^import (?!type )/m,
      );
    });

    it("matches the app's isTileTemplate row by row", async () => {
      dir = mkdtempSync(join(tmpdir(), "trajetto-mobile-map-rules-"));

      const copy = join(dir, "map-config-rules.ts");

      copyFileSync(APP_MAP_CONFIG_RULES, copy);

      const app = (await import(/* @vite-ignore */ copy)) as {
        isTileTemplate: (
          value: unknown,
          rules: { allowHttp: boolean },
        ) => boolean;
      };

      for (const [label, value, appEnv, expected] of APP_PARITY) {
        expect(
          app.isTileTemplate(value, { allowHttp: appEnv === "development" }),
          label,
        ).toBe(expected);
      }
    });
  },
);

describe("isPublicOsmTemplate", () => {
  it("names the public OSM tile servers, with or without a subdomain", () => {
    expect(isPublicOsmTemplate(OSM_TILES.url)).toBe(true);
    expect(
      isPublicOsmTemplate("https://tile.openstreetmap.org/{z}/{x}/{y}.png"),
    ).toBe(true);
    expect(isPublicOsmTemplate(LIGHT)).toBe(false);
    expect(
      isPublicOsmTemplate(
        "https://tile.openstreetmap.org.evil.test/{z}/{x}/{y}",
      ),
    ).toBe(false);
  });
});

const production = {
  NODE_ENV: "production",
  REDIS_URL: "redis://redis:6379",
  HTTP_REQUEST: "https://app.example.com",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  TURNSTILE_SECRET_KEY: "0x4AAAAAAATEST-turnstile-secret",
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
  UPLOAD_STORAGE_TYPE: "r2",
  R2_ACCOUNT_ID: "a",
  R2_BUCKET_NAME: "b",
  R2_ACCESS_KEY_ID: "c",
  R2_SECRET_ACCESS_KEY: "d",
  RATE_LIMIT_TRUSTED_PROXY: "cloudflare",
  WEBHOOK_SECRETS_KEY: Buffer.alloc(32).toString("base64"),
};

const development = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (source: Record<string, string>) =>
  envSchema.safeParse(definedEnv(source));

function issuesOf(source: Record<string, string>) {
  const parsed = parse(source);

  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      }));
}

describe("the MAP_TILE_* variables in the env schema", () => {
  // The production branch warns on the console; kept quiet and read back.
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("are optional, and empty counts as absent", () => {
    const parsed = parse({
      ...production,
      MAP_TILE_URL: "",
      MAP_TILE_ATTRIBUTION: "",
      MAP_TILE_URL_DARK: "",
      MAP_TILE_ATTRIBUTION_DARK: "",
    });

    expect(parsed.success).toBe(true);
    expect(
      parsed.success && resolveMapTiles(mapTileSettingsFrom(parsed.data)),
    ).toBeNull();
  });

  it("reach GET /config/map's resolver as the web's values were set", () => {
    const parsed = parse({
      ...production,
      APP_ENV: "staging",
      MAP_TILE_URL: LIGHT,
      MAP_TILE_ATTRIBUTION: "© MapTiler © colaboradores do OpenStreetMap",
      MAP_TILE_URL_DARK: DARK,
    });

    expect(parsed.success).toBe(true);
    expect(
      parsed.success && resolveMapTiles(mapTileSettingsFrom(parsed.data)),
    ).toEqual({
      url: LIGHT,
      attribution: "© MapTiler © colaboradores do OpenStreetMap",
      dark: {
        url: DARK,
        attribution: "© MapTiler © colaboradores do OpenStreetMap",
      },
    });
  });

  it("refuse a broken template by name, without echoing its key", () => {
    for (const field of ["MAP_TILE_URL", "MAP_TILE_URL_DARK"]) {
      const source = {
        ...production,
        MAP_TILE_URL: LIGHT,
        [field]: "https://tiles.example.test/tiles.png?key=leaky-secret",
      };
      const issues = issuesOf(source);

      expect(issues.map((issue) => issue.path)).toEqual([field]);
      expect(issues[0].message).toContain("modelo https com {z}, {x} e {y}");
      expect(JSON.stringify(parse(source))).not.toContain("leaky-secret");
    }
  });

  it("refuse at boot every template the app would refuse, light or dark, by name", () => {
    for (const [label, value, appEnv, expected] of APP_PARITY) {
      if (expected) continue;

      const env =
        appEnv === "development"
          ? development
          : { ...production, APP_ENV: appEnv };

      for (const field of ["MAP_TILE_URL", "MAP_TILE_URL_DARK"]) {
        const source = { ...env, MAP_TILE_URL: LIGHT, [field]: value };

        expect(
          issuesOf(source).map((issue) => issue.path),
          `${label} in ${field}`,
        ).toEqual([field]);
      }
    }
  });

  it("boot with the web's real templates", () => {
    for (const [label, value, appEnv, expected] of APP_PARITY) {
      if (!expected || appEnv === "development") continue;

      expect(
        issuesOf({ ...production, APP_ENV: appEnv, MAP_TILE_URL: value }),
        label,
      ).toEqual([]);
    }
  });

  it("refuse http outside development and accept it in development", () => {
    const http = "http://localhost:8080/{z}/{x}/{y}.png";

    expect(issuesOf({ ...production, MAP_TILE_URL: http })).toHaveLength(1);
    expect(
      issuesOf({ ...production, APP_ENV: "staging", MAP_TILE_URL: http }),
    ).toHaveLength(1);
    expect(issuesOf({ ...development, MAP_TILE_URL: http })).toEqual([]);
    // The load harness runs the production image as development.
    expect(
      issuesOf({ ...production, APP_ENV: "development", MAP_TILE_URL: http }),
    ).toEqual([]);
  });

  it("refuse the public OSM servers outside development", () => {
    for (const env of [production, { ...production, APP_ENV: "staging" }]) {
      expect(
        issuesOf({ ...env, MAP_TILE_URL: OSM_TILES.url }).map(
          (issue) => issue.path,
        ),
      ).toEqual(["MAP_TILE_URL"]);
      expect(
        issuesOf({
          ...env,
          MAP_TILE_URL: LIGHT,
          MAP_TILE_URL_DARK: OSM_TILES.url,
        }).map((issue) => issue.path),
      ).toEqual(["MAP_TILE_URL_DARK"]);
    }

    expect(issuesOf({ ...development, MAP_TILE_URL: OSM_TILES.url })).toEqual(
      [],
    );
  });

  it("warn in production about a dark style with no base, and a provider with no credit", () => {
    const warn = vi.mocked(console.warn);

    expect(parse({ ...production, MAP_TILE_URL_DARK: DARK }).success).toBe(
      true,
    );
    expect(warn.mock.calls.flat().join(" ")).toContain(
      "MAP_TILE_URL_DARK ignorada sem MAP_TILE_URL",
    );

    warn.mockClear();

    expect(parse({ ...production, MAP_TILE_URL: LIGHT }).success).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toContain(
      "MAP_TILE_ATTRIBUTION ausente",
    );

    warn.mockClear();

    // Fully configured: nothing to say, and never the key.
    expect(
      parse({
        ...production,
        MAP_TILE_URL: LIGHT,
        MAP_TILE_ATTRIBUTION: "© Exemplo",
        MAP_TILE_URL_DARK: DARK,
      }).success,
    ).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("MAP_TILE");
  });
});
