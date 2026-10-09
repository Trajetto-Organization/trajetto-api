import { describe, expect, it } from "vitest";

import { deflateSync } from "node:zlib";

import {
  MAX_TILE_BYTES,
  fetchProofMap,
  isAcceptableTile,
  type TileFetch,
} from "@/shared/services/proof-location/map-tiles";
import {
  ProofLocationService,
  type ProofLocationConfig,
} from "@/shared/services/proof-location/proof-location-service";
import {
  parseNominatimAddress,
  reverseGeocode,
  reverseUrl,
  type GeocodeFetch,
} from "@/shared/services/proof-location/reverse-geocoder";
import {
  projectToPixels,
  tileUrl,
  tileViewport,
} from "@/shared/services/proof-location/web-mercator";
import type { ProofDocumentSource } from "@/shared/delivery/proof-document";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * Where the proof was recorded (decision 14.8, design §5): the static map's
 * tile arithmetic, the tile gate, the reverse geocoder's parsing and the
 * cache rules. The network is a function passed in — what is proven is our
 * handling of its answers, never the provider.
 */
function tinyPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, "latin1"), data, Buffer.alloc(4)]);
  };

  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.from([0, 200, 220, 190]))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function response(status: number, body: Buffer, type: string) {
  return {
    status,
    headers: {
      get: (name: string) =>
        name === "content-type" ? type : name === "content-length" ? String(body.length) : null,
    },
    arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    json: async () => JSON.parse(body.toString("utf8")),
  };
}

describe("the map's tiles (Web Mercator)", () => {
  it("projects known points to their global pixels", () => {
    expect(projectToPixels(0, 0, 0)).toEqual({ x: 128, y: 128 });

    // The OSM wiki's slippy-map formula, written independently (asinh).
    const lat = -20.3502181;
    const lng = -40.3038332;
    const n = 2 ** 16;
    const column = Math.floor(((lng + 180) / 360) * n);
    const row = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);

    const { x, y } = projectToPixels(lat, lng, 16);

    expect([Math.floor(x / 256), Math.floor(y / 256)]).toEqual([column, row]);
    expect(column).toBe(25430);
  });

  it("covers a 400×170 viewport centred on the point with at most a 3×2 grid", () => {
    const viewport = tileViewport(-20.3502181, -40.3038332, { zoom: 16, width: 400, height: 170 });

    expect(viewport.marker).toEqual({ x: 200, y: 85 });
    expect(viewport.tiles.length).toBeGreaterThanOrEqual(2);
    expect(viewport.tiles.length).toBeLessThanOrEqual(6);

    // Together the tiles cover the whole viewport.
    const left = Math.min(...viewport.tiles.map((tile) => tile.left));
    const top = Math.min(...viewport.tiles.map((tile) => tile.top));
    const right = Math.max(...viewport.tiles.map((tile) => tile.left + 256));
    const bottom = Math.max(...viewport.tiles.map((tile) => tile.top + 256));

    expect(left).toBeLessThanOrEqual(0);
    expect(top).toBeLessThanOrEqual(0);
    expect(right).toBeGreaterThanOrEqual(400);
    expect(bottom).toBeGreaterThanOrEqual(170);
  });

  it("wraps columns across the antimeridian", () => {
    const viewport = tileViewport(0, 179.9999, { zoom: 2, width: 400, height: 170 });

    expect(viewport.tiles.map((tile) => tile.x)).toContain(0);
    expect(viewport.tiles.every((tile) => tile.x >= 0 && tile.x < 4)).toBe(true);
  });

  it("fills the XYZ template, subdomain included", () => {
    expect(tileUrl("https://{s}.tiles.example/{z}/{x}/{y}.png?key=k", { z: 16, x: 1, y: 2 })).toBe(
      "https://a.tiles.example/16/1/2.png?key=k",
    );
  });
});

describe("the map is all or nothing", () => {
  const options = (fetcher: TileFetch) => ({
    template: "https://tiles.example/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap",
    timeoutMs: 1000,
    userAgent: "Trajetto/test",
    fetcher,
  });

  it("accepts real PNG and JPEG tiles only", () => {
    expect(isAcceptableTile(tinyPng(), "image/png")).toBe(true);
    expect(isAcceptableTile(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]), "image/jpeg")).toBe(true);
    expect(isAcceptableTile(tinyPng(), "text/html")).toBe(false);
    expect(isAcceptableTile(Buffer.from("<html>"), "image/png")).toBe(false);
    expect(isAcceptableTile(Buffer.alloc(MAX_TILE_BYTES + 1), "image/jpeg")).toBe(false);
  });

  it("returns every tile with its offset when all of them are good", async () => {
    const map = await fetchProofMap(-20.35, -40.3, options(async () => response(200, tinyPng(), "image/png")));

    expect(map).not.toBeNull();
    expect(map!.attribution).toBe("© OpenStreetMap");
    expect(map!.tiles.length).toBeGreaterThanOrEqual(2);
  });

  it.each([
    ["an HTTP error", () => response(500, Buffer.alloc(0), "text/plain")],
    ["a corrupt PNG", () => response(200, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]), "image/png")],
    ["an HTML page", () => response(200, Buffer.from("<html></html>"), "text/html")],
  ])("is dropped whole when one tile is %s", async (_, bad) => {
    let calls = 0;

    const map = await fetchProofMap(
      -20.35,
      -40.3,
      options(async () => {
        calls += 1;
        return calls === 2 ? bad() : response(200, tinyPng(), "image/png");
      }),
    );

    expect(map).toBeNull();
  });

  it("is dropped when the provider throws (timeout, DNS)", async () => {
    const map = await fetchProofMap(-20.35, -40.3, options(async () => {
      throw new Error("aborted");
    }));

    expect(map).toBeNull();
  });

  it("is not even attempted without a template or an attribution", async () => {
    let called = false;
    const fetcher: TileFetch = async () => {
      called = true;
      return response(200, tinyPng(), "image/png");
    };

    expect(await fetchProofMap(1, 1, { ...options(fetcher), template: undefined })).toBeNull();
    expect(await fetchProofMap(1, 1, { ...options(fetcher), attribution: undefined })).toBeNull();
    expect(called).toBe(false);
  });
});

describe("the reverse geocoder", () => {
  const NOMINATIM = {
    address: {
      road: "Rua Alberto de Oliveira Santos",
      house_number: "117",
      suburb: "Soteco",
      city: "Vila Velha",
      state: "Espírito Santo",
      postcode: "29106-100",
      country_code: "br",
    },
  };

  it("reads a Nominatim jsonv2 answer as the PDF's address", () => {
    expect(parseNominatimAddress(NOMINATIM)).toEqual({
      line: "Rua Alberto de Oliveira Santos, 117",
      district: "Soteco",
      city: "Vila Velha",
      state: "Espírito Santo",
      cep: "29106-100",
    });

    expect(parseNominatimAddress({ error: "Unable to geocode" })).toBeNull();
    expect(parseNominatimAddress({ address: { country: "Brasil" } })).toBeNull();
  });

  it("asks with the protocol's parameters and the key in its configured parameter", () => {
    const url = new URL(
      reverseUrl({ url: "https://geo.example/", key: "segredo", keyParam: "api_key" }, -20.35, -40.3),
    );

    expect(url.pathname).toBe("/reverse");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("lat")).toBe("-20.35");
    expect(url.searchParams.get("lon")).toBe("-40.3");
    expect(url.searchParams.get("accept-language")).toBe("pt-BR");
    expect(url.searchParams.get("api_key")).toBe("segredo");
  });

  it("answers null — never throws — on errors, timeouts and points not worth asking", async () => {
    const config = { url: "https://geo.example", key: undefined, keyParam: "key", userAgent: "t", timeoutMs: 100 };
    let calls = 0;
    const failing: GeocodeFetch = async () => {
      calls += 1;
      throw new Error("timeout");
    };

    expect(await reverseGeocode(-20.35, -40.3, config, failing)).toBeNull();
    expect(await reverseGeocode(-20.35, -40.3, config, async () => ({ status: 503, json: async () => ({}) }))).toBeNull();

    // (0,0) and out-of-range points are never sent.
    expect(await reverseGeocode(0, 0, config, failing)).toBeNull();
    expect(await reverseGeocode(91, 0, config, failing)).toBeNull();
    expect(calls).toBe(1);
  });
});

describe("the address cache on the proof event", () => {
  const proof = (overrides: Partial<NonNullable<ProofDocumentSource["proof"]>> = {}) => ({
    eventId: "event-1",
    created_at: new Date(),
    latitude: -20.35,
    longitude: -40.3,
    photoKey: null,
    signatureKey: null,
    ...overrides,
  });

  function service(fetcher: GeocodeFetch, url: string | null = "https://geo.example") {
    const config: ProofLocationConfig = {
      geocoder: { url: url ?? undefined, key: undefined, keyParam: "key", userAgent: "t", timeoutMs: 100 },
      map: { template: undefined, attribution: undefined, timeoutMs: 100 },
      fetcher: fetcher as ProofLocationConfig["fetcher"],
    };

    return new ProofLocationService(config);
  }

  const answering = (body: unknown) => {
    const calls: string[] = [];
    const fetcher: GeocodeFetch = async (url) => {
      calls.push(url);
      return { status: 200, json: async () => body };
    };

    return { calls, fetcher };
  };

  it("asks the provider once and asks to persist its answer", async () => {
    const { calls, fetcher } = answering({ address: { road: "Rua A", city: "Vila Velha" } });

    const resolved = await service(fetcher).resolveAddress(proof());

    expect(calls).toHaveLength(1);
    expect(resolved).toMatchObject({ source: "PROVIDER", persist: true });
    expect(resolved!.address!.line).toBe("Rua A");
  });

  it("reuses a cached PROVIDER address without asking", async () => {
    const { calls, fetcher } = answering({});
    const cached = { line: "Rua B", district: null, city: null, state: null, cep: null };

    const resolved = await service(fetcher).resolveAddress(
      proof({ gps_address: cached, gps_address_source: "PROVIDER", gps_geocoded_at: new Date() }),
    );

    expect(calls).toHaveLength(0);
    expect(resolved).toEqual({ address: cached, source: "PROVIDER", persist: false });
  });

  it("does not retry an UNAVAILABLE answer for 24 h, and retries after", async () => {
    const { calls, fetcher } = answering({ address: { road: "Rua C" } });
    const now = new Date("2026-10-05T12:00:00Z");

    const recent = await service(fetcher).resolveAddress(
      proof({ gps_address_source: "UNAVAILABLE", gps_geocoded_at: new Date("2026-10-05T00:00:00Z") }),
      now,
    );

    expect(recent).toEqual({ address: null, source: "UNAVAILABLE", persist: false });
    expect(calls).toHaveLength(0);

    const stale = await service(fetcher).resolveAddress(
      proof({ gps_address_source: "UNAVAILABLE", gps_geocoded_at: new Date("2026-10-04T11:00:00Z") }),
      now,
    );

    expect(stale).toMatchObject({ source: "PROVIDER", persist: true });
    expect(calls).toHaveLength(1);
  });

  it("records UNAVAILABLE when the provider fails, so it is not asked on every render", async () => {
    const resolved = await service(async () => ({ status: 500, json: async () => ({}) })).resolveAddress(proof());

    expect(resolved).toEqual({ address: null, source: "UNAVAILABLE", persist: true });
  });

  it("does nothing — and records nothing — without a provider or without a fix", async () => {
    const { calls, fetcher } = answering({});

    expect(await service(fetcher, null).resolveAddress(proof())).toBeNull();
    expect(await service(fetcher).resolveAddress(proof({ latitude: null, longitude: null }))).toBeNull();
    expect(await service(fetcher).resolveAddress(null)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("falls back without recording when 4 lookups are already in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const slow: GeocodeFetch = async () => {
      await gate;
      return { status: 200, json: async () => ({ address: { road: "Rua D" } }) };
    };

    const location = service(slow);
    const inFlight = Array.from({ length: 4 }, () => location.resolveAddress(proof()));

    expect(await location.resolveAddress(proof())).toEqual({
      address: null,
      source: "UNAVAILABLE",
      persist: false,
    });

    release();

    for (const result of await Promise.all(inFlight)) {
      expect(result).toMatchObject({ source: "PROVIDER", persist: true });
    }
  });
});

describe("the providers the configuration accepts", () => {
  const issues = (overrides: Record<string, string>) => {
    const parsed = envSchema.safeParse({ ...definedEnv(process.env), ...overrides });

    return parsed.success ? [] : parsed.error.issues.map((issue) => issue.path.join("."));
  };

  it("refuses the public OpenStreetMap services in production, whose policy forbids this use", () => {
    const production = issues({
      NODE_ENV: "production",
      PROOF_MAP_TILE_URL: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      PROOF_MAP_TILE_ATTRIBUTION: "© OpenStreetMap",
      REVERSE_GEOCODER_URL: "https://nominatim.openstreetmap.org",
    });

    expect(production).toContain("PROOF_MAP_TILE_URL");
    expect(production).toContain("REVERSE_GEOCODER_URL");
  });

  it("accepts them in development, and requires https from any provider in production", () => {
    const development = issues({
      NODE_ENV: "development",
      PROOF_MAP_TILE_URL: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      PROOF_MAP_TILE_ATTRIBUTION: "© OpenStreetMap",
      REVERSE_GEOCODER_URL: "https://nominatim.openstreetmap.org",
    });

    expect(development).not.toContain("PROOF_MAP_TILE_URL");
    expect(development).not.toContain("REVERSE_GEOCODER_URL");

    expect(
      issues({ NODE_ENV: "production", REVERSE_GEOCODER_URL: "http://nominatim.interno:8080" }),
    ).toContain("REVERSE_GEOCODER_URL");
  });
});
