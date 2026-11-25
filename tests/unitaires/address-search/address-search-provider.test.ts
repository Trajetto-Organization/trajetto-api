import { describe, expect, it } from "vitest";

import {
  PROVIDER_RESULTS,
  providerUrl,
  searchPlaces,
  type AddressSearchProviderConfig,
} from "@/shared/services/address-search/address-search-provider";
import type { GeocodeFetch } from "@/shared/services/proof-location/reverse-geocoder";

/**
 * The provider behind "Fixar no mapa"'s search (plan pin-search): the URL
 * of each protocol, and what each answer comes to. The URL carries the key,
 * so nothing here is ever logged by the code under test.
 */
const LOCATIONIQ: AddressSearchProviderConfig = {
  url: "https://api.locationiq.com/v1",
  protocol: "locationiq-autocomplete",
  key: "pk.test-key",
  keyParam: "key",
  userAgent: "Trajetto/test",
  timeoutMs: 2_500,
};

const NOMINATIM: AddressSearchProviderConfig = {
  ...LOCATIONIQ,
  url: "http://nominatim.interno:8080/",
  protocol: "nominatim-search",
  key: undefined,
};

const SEARCH = {
  text: "Rua Epitácio Pessoa, 120, Petrópolis, Rio de Janeiro",
  viewbox: [-43.3, -22.6, -43.0, -22.4] as [number, number, number, number],
};

function answer(status: number, body: unknown): GeocodeFetch {
  return async () => ({
    status,
    json: async () => {
      if (body === undefined) throw new SyntaxError("Unexpected token <");
      return body;
    },
  });
}

const live = () => new AbortController().signal;

describe("the request each protocol sends", () => {
  it("asks LocationIQ's autocomplete in Brazil, leaning toward the stops, with the key", () => {
    const url = new URL(providerUrl(LOCATIONIQ, SEARCH));

    expect(url.origin + url.pathname).toBe(
      "https://api.locationiq.com/v1/autocomplete",
    );
    expect(url.searchParams.get("q")).toBe(SEARCH.text);
    expect(url.searchParams.get("countrycodes")).toBe("br");
    expect(url.searchParams.get("limit")).toBe(String(PROVIDER_RESULTS));
    expect(url.searchParams.get("accept-language")).toBe("native");
    expect(url.searchParams.get("viewbox")).toBe("-43.3,-22.6,-43,-22.4");
    // A lean, never a filter: a place outside the stops' box still shows.
    expect(url.searchParams.get("bounded")).toBe("0");
    expect(url.searchParams.get("key")).toBe("pk.test-key");
  });

  it("sends only what the autocomplete documents: an unknown parameter's 400 would pause the search", () => {
    const url = new URL(providerUrl(LOCATIONIQ, { ...SEARCH, viewbox: null }));

    expect([...url.searchParams.keys()].sort()).toEqual(
      ["accept-language", "countrycodes", "key", "limit", "q"].sort(),
    );
  });

  it("asks a Nominatim of our own with the forward geocoder's request", () => {
    const url = new URL(providerUrl(NOMINATIM, SEARCH));

    expect(url.origin + url.pathname).toBe(
      "http://nominatim.interno:8080/search",
    );
    expect(url.searchParams.get("q")).toBe(SEARCH.text);
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("addressdetails")).toBe("1");
    expect(url.searchParams.get("countrycodes")).toBe("br");
    expect(url.searchParams.get("accept-language")).toBe("pt-BR");
    expect(url.searchParams.get("viewbox")).toBe("-43.3,-22.6,-43,-22.4");
    expect(url.searchParams.get("bounded")).toBe("0");
    expect(url.searchParams.get("limit")).toBe(String(PROVIDER_RESULTS));
    expect(url.searchParams.has("key")).toBe(false);
  });
});

describe("what an answer comes to", () => {
  it("is FOUND with the places of a list", async () => {
    const outcome = await searchPlaces(
      LOCATIONIQ,
      SEARCH,
      live(),
      answer(200, [{ lat: "-22.5", lon: "-43.17" }, null, "x"]),
    );

    expect(outcome).toEqual({
      kind: "FOUND",
      places: [{ lat: "-22.5", lon: "-43.17" }],
    });
  });

  it("is NOT_FOUND for an empty list and for LocationIQ's 404 with its JSON error", async () => {
    expect(
      await searchPlaces(LOCATIONIQ, SEARCH, live(), answer(200, [])),
    ).toEqual({ kind: "NOT_FOUND" });
    expect(
      await searchPlaces(
        LOCATIONIQ,
        SEARCH,
        live(),
        answer(404, { error: "Unable to geocode" }),
      ),
    ).toEqual({ kind: "NOT_FOUND" });
  });

  it.each([
    [401, { error: "Invalid key" }],
    [403, { error: "Key not active" }],
    // A path that is not the provider's API.
    [404, undefined],
  ])("is REFUSED for %i: the account or the URL", async (status, body) => {
    expect(
      await searchPlaces(LOCATIONIQ, SEARCH, live(), answer(status, body)),
    ).toEqual({ kind: "REFUSED", status });
  });

  it.each([
    [400, { error: "Invalid request" }],
    [414, undefined],
    [422, { error: "Unprocessable" }],
  ])(
    "is REJECTED for %i: the text a person typed, never the account",
    async (status, body) => {
      expect(
        await searchPlaces(LOCATIONIQ, SEARCH, live(), answer(status, body)),
      ).toEqual({ kind: "REJECTED", status });
    },
  );

  it("is REFUSED for a 200 that is not a list (a web page, an error object)", async () => {
    expect(
      await searchPlaces(LOCATIONIQ, SEARCH, live(), answer(200, undefined)),
    ).toEqual({ kind: "REFUSED", status: 200 });
    expect(
      await searchPlaces(
        LOCATIONIQ,
        SEARCH,
        live(),
        answer(200, { error: "x" }),
      ),
    ).toEqual({ kind: "REFUSED", status: 200 });
  });

  it("tells the day's quota from a burst", async () => {
    expect(
      await searchPlaces(
        LOCATIONIQ,
        SEARCH,
        live(),
        answer(429, { error: "Rate Limited Day" }),
      ),
    ).toEqual({ kind: "RATE_LIMITED", status: 429, scope: "DAY" });

    for (const error of ["Rate Limited Second", "Rate Limited Minute"]) {
      expect(
        await searchPlaces(LOCATIONIQ, SEARCH, live(), answer(429, { error })),
      ).toEqual({ kind: "RATE_LIMITED", status: 429, scope: "SHORT" });
    }
  });

  it("is FAILED for a 5xx, a 408 and a provider that does not answer", async () => {
    expect(
      await searchPlaces(LOCATIONIQ, SEARCH, live(), answer(503, undefined)),
    ).toEqual({ kind: "FAILED", status: 503 });
    expect(
      await searchPlaces(LOCATIONIQ, SEARCH, live(), answer(408, undefined)),
    ).toEqual({ kind: "FAILED", status: 408 });
    expect(
      await searchPlaces(LOCATIONIQ, SEARCH, live(), async () => {
        throw new TypeError("fetch failed");
      }),
    ).toEqual({ kind: "FAILED", status: null });
  });

  it("is FAILED, never REFUSED, when the timeout cuts the body", async () => {
    const outcome = await searchPlaces(
      { ...LOCATIONIQ, timeoutMs: 20 },
      SEARCH,
      live(),
      async (_url, init) => ({
        status: 200,
        json: () =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            ),
          ),
      }),
    );

    expect(outcome).toEqual({ kind: "FAILED", status: null });
  });

  it("is ABORTED when the person typed again, whatever was on the wire", async () => {
    const person = new AbortController();

    const outcome = await searchPlaces(
      LOCATIONIQ,
      SEARCH,
      person.signal,
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
          person.abort();
        }),
    );

    expect(outcome).toEqual({ kind: "ABORTED" });
  });
});
