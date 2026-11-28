import { describe, expect, it } from "vitest";

import {
  ADDRESS_SEARCH_MAX_CITY,
  addressSearchQuerySchema,
} from "@/modules/address-search/schemas/address-search-schemas";
import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

/**
 * What the address search accepts from the environment and from the page
 * (plan pin-search; the owner's decisions of 10/11/2026: 1,000 searches a
 * day for the platform, 150 for each company, LocationIQ's key).
 */
const DEVELOPMENT = {
  NODE_ENV: "development",
  REDIS_URL: "redis://localhost:6379",
  HTTP_REQUEST: "http://localhost:3000",
  JWT_SECRET: "a".repeat(32),
  JWT_SECRET_REFRESH_TOKEN: "b".repeat(32),
  MASTER_USER_EMAIL: "master@example.com",
  MASTER_USER_INITIAL_PASSWORD: "x",
};

const parse = (overrides: Record<string, string | undefined>) =>
  envSchema.safeParse(
    definedEnv(
      Object.fromEntries(
        Object.entries({ ...DEVELOPMENT, ...overrides }).filter(
          ([, value]) => value !== undefined,
        ),
      ),
    ),
  );

const issues = (overrides: Record<string, string | undefined>) => {
  const parsed = parse(overrides);

  return parsed.success
    ? []
    : parsed.error.issues.map((issue) => issue.path.join("."));
};

describe("the environment", () => {
  it("defaults to 1,000 a day for the platform, 150 for a company and 48 h of cache, off without a URL", () => {
    const parsed = parse({});

    expect(parsed.success).toBe(true);
    expect(parsed.data).toMatchObject({
      ADDRESS_SEARCH_PROTOCOL: "nominatim-search",
      ADDRESS_SEARCH_DAILY_BUDGET: 1000,
      ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT: 150,
      ADDRESS_SEARCH_CACHE_SECONDS: 172_800,
    });
    expect(parsed.data?.ADDRESS_SEARCH_URL).toBeUndefined();
  });

  it("reads an empty variable from the compose as unset", () => {
    const parsed = parse({
      ADDRESS_SEARCH_URL: "",
      ADDRESS_SEARCH_DAILY_BUDGET: "",
      ADDRESS_SEARCH_PROTOCOL: "",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.ADDRESS_SEARCH_DAILY_BUDGET).toBe(1000);
    expect(parsed.data?.ADDRESS_SEARCH_PROTOCOL).toBe("nominatim-search");
  });

  it("takes LocationIQ's autocomplete, and a budget of 0 to switch the search off", () => {
    const parsed = parse({
      ADDRESS_SEARCH_URL: "https://api.locationiq.com/v1",
      ADDRESS_SEARCH_PROTOCOL: "locationiq-autocomplete",
      ADDRESS_SEARCH_DAILY_BUDGET: "0",
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.ADDRESS_SEARCH_DAILY_BUDGET).toBe(0);
  });

  it("refuses a cache past the free tier's 48 h, an unknown protocol and a company limit of 0", () => {
    expect(issues({ ADDRESS_SEARCH_CACHE_SECONDS: "172801" })).toContain(
      "ADDRESS_SEARCH_CACHE_SECONDS",
    );
    expect(issues({ ADDRESS_SEARCH_PROTOCOL: "google" })).toContain(
      "ADDRESS_SEARCH_PROTOCOL",
    );
    expect(issues({ ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT: "0" })).toContain(
      "ADDRESS_SEARCH_BUSINESS_DAILY_LIMIT",
    );
  });

  it("refuses the public Nominatim in production, whose policy forbids searching as you type", () => {
    // The production rules run once the base passes; this one is checked
    // beside whatever else a bare production environment lacks.
    expect(
      issues({
        NODE_ENV: "production",
        ADDRESS_SEARCH_URL: "https://nominatim.openstreetmap.org",
      }),
    ).toContain("ADDRESS_SEARCH_URL");
    expect(
      issues({
        NODE_ENV: "production",
        ADDRESS_SEARCH_URL: "https://api.locationiq.com/v1",
      }),
    ).not.toContain("ADDRESS_SEARCH_URL");
    expect(
      issues({
        NODE_ENV: "development",
        ADDRESS_SEARCH_URL: "https://nominatim.openstreetmap.org",
      }),
    ).not.toContain("ADDRESS_SEARCH_URL");
  });
});

describe("the query the page sends", () => {
  const query = (input: Record<string, unknown>) =>
    addressSearchQuerySchema.safeParse(input);

  it("collapses spaces, upper-cases the UF and defaults to 8 suggestions", () => {
    const parsed = query({
      q: "  Rua   Epitácio Pessoa,  120 ",
      city: " Petrópolis ",
      uf: "rj",
    });

    expect(parsed.success && parsed.data).toEqual({
      q: "Rua Epitácio Pessoa, 120",
      city: "Petrópolis",
      uf: "RJ",
      limit: 8,
    });
  });

  it.each([
    [{ q: "ab" }, "Digite ao menos 3 caracteres"],
    [{ q: "x".repeat(201) }, "até 200 caracteres"],
    [{ q: "Rua X", city: "Petrópolis" }, "cidade e a UF juntas"],
    [{ q: "Rua X", uf: "RJ" }, "cidade e a UF juntas"],
    [{ q: "Rua X", city: "Petrópolis", uf: "XX" }, "27 siglas"],
    [{ q: "Rua X", city: "C".repeat(101), uf: "RJ" }, "até 100 caracteres"],
    [{ q: "Rua X", viewbox: "-9.2,38.6,-9.0,38.8" }, "dentro do Brasil"],
    [{ q: "Rua X", viewbox: "-60,-30,-40,-10" }, "10° de lado"],
    [{ q: "Rua X", viewbox: "-43,-22" }, "oeste,sul,leste,norte"],
    [{ q: "Rua X", limit: "11" }, "de 1 a 10"],
  ])("refuses %j", (input, message) => {
    const parsed = query(input);

    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(message);
  });

  it("takes any city a delivery can store: up to its 100 characters", () => {
    expect(ADDRESS_SEARCH_MAX_CITY).toBe(100);
    expect(
      query({ q: "Rua X", city: "C".repeat(ADDRESS_SEARCH_MAX_CITY), uf: "RJ" })
        .success,
    ).toBe(true);
  });

  it("takes the stops' box inside Brazil", () => {
    expect(
      query({ q: "Rua X", viewbox: "-43.30,-22.60,-43.00,-22.40" }).success,
    ).toBe(true);
  });
});
