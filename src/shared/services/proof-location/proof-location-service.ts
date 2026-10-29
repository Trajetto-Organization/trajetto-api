import { instanceCachingFactory, registry } from "tsyringe";

import { env } from "@/env";
import type {
  GpsAddress,
  ProofDocumentSource,
} from "@/shared/delivery/proof-document";

import { fetchProofMap, type ProofMapImage, type TileFetch } from "./map-tiles";
import {
  Semaphore,
  isQueryablePoint,
  reverseGeocode,
  type GeocodeFetch,
  type ReverseGeocoderConfig,
} from "./reverse-geocoder";

/** An UNAVAILABLE answer is not retried before this (design §4.2). */
const UNAVAILABLE_RETRY_MS = 24 * 60 * 60 * 1000;

/** Lookups in flight per replica (design §5.1). */
const MAX_CONCURRENT_LOOKUPS = 4;

interface ProofLocationConfig {
  geocoder: ReverseGeocoderConfig;
  map: {
    template: string | undefined;
    attribution: string | undefined;
    timeoutMs: number;
    referer?: string;
  };
  fetcher?: GeocodeFetch & TileFetch;
}

/** The outcome of one look at the proof's address. */
interface AddressResolution {
  address: GpsAddress | null;
  source: "PROVIDER" | "UNAVAILABLE";

  /** Whether to write it on the event; false when the answer is a cache hit
   * or the lookup was skipped for lack of capacity. */
  persist: boolean;
}

function userAgent(): string {
  return (
    env.REVERSE_GEOCODER_USER_AGENT ?? `Trajetto/1.0 (+${env.HTTP_REQUEST})`
  );
}

/**
 * The web origin of this environment, as a Referer for the map tiles: the
 * MapTiler key is shared with the web's map and restricted to the web's
 * origins, so the API asks as the site it renders proofs for.
 */
function webReferer(): string | undefined {
  try {
    return `${new URL(env.HTTP_REQUEST).origin}/`;
  } catch {
    return undefined;
  }
}

function configFromEnv(): ProofLocationConfig {
  return {
    geocoder: {
      url: env.REVERSE_GEOCODER_URL,
      key: env.REVERSE_GEOCODER_KEY,
      keyParam: env.REVERSE_GEOCODER_KEY_PARAM,
      userAgent: userAgent(),
      timeoutMs: env.REVERSE_GEOCODER_TIMEOUT_MS,
    },
    map: {
      template: env.PROOF_MAP_TILE_URL,
      attribution: env.PROOF_MAP_TILE_ATTRIBUTION,
      timeoutMs: env.PROOF_MAP_TIMEOUT_MS,
      referer: webReferer(),
    },
  };
}

/**
 * Where the proof was recorded, in words and in a picture (decision 14.8,
 * design §5): the reverse-geocoded address of the GPS fix, cached on the
 * proof event so a regeneration prints the same text and the provider is
 * asked once, and the static map tiles, fetched fresh on every render
 * (storing tiles runs into most providers' terms).
 *
 * Both are optional: without a provider the PDF has labelled fallbacks.
 */
@registry([
  {
    token: "ProofLocationService",
    useFactory: instanceCachingFactory(() => new ProofLocationService()),
  },
])
class ProofLocationService {
  private readonly lookups = new Semaphore(MAX_CONCURRENT_LOOKUPS);

  constructor(private readonly config: ProofLocationConfig = configFromEnv()) {}

  /**
   * The address of the proof's fix: from the cache, from the provider, or
   * null when there is nothing to ask (no fix, no provider).
   */
  async resolveAddress(
    proof: ProofDocumentSource["proof"],
    now: Date = new Date(),
  ): Promise<AddressResolution | null> {
    if (!proof) return null;

    const { latitude, longitude } = proof;

    if (
      typeof latitude !== "number" ||
      typeof longitude !== "number" ||
      !isQueryablePoint(latitude, longitude)
    ) {
      return null;
    }

    if (proof.gps_address_source === "PROVIDER" && proof.gps_address) {
      return { address: proof.gps_address, source: "PROVIDER", persist: false };
    }

    if (proof.gps_address_source === "UNAVAILABLE" && proof.gps_geocoded_at) {
      const at = new Date(proof.gps_geocoded_at).getTime();

      if (Number.isFinite(at) && now.getTime() - at < UNAVAILABLE_RETRY_MS) {
        return { address: null, source: "UNAVAILABLE", persist: false };
      }
    }

    // Switched off: nothing was tried, so nothing is recorded.
    if (!this.config.geocoder.url) return null;

    const release = this.lookups.tryAcquire();

    // Busy: render with the fallback and let the next request try.
    if (!release)
      return { address: null, source: "UNAVAILABLE", persist: false };

    try {
      const address = await reverseGeocode(
        latitude,
        longitude,
        this.config.geocoder,
        this.config.fetcher,
      );

      return address
        ? { address, source: "PROVIDER", persist: true }
        : { address: null, source: "UNAVAILABLE", persist: true };
    } finally {
      release();
    }
  }

  /** The map around the fix, or null (no provider, no fix, any bad tile). */
  async map(
    point: { latitude: number; longitude: number } | null,
  ): Promise<ProofMapImage | null> {
    if (!point || !this.config.map.template) return null;

    return fetchProofMap(point.latitude, point.longitude, {
      template: this.config.map.template,
      attribution: this.config.map.attribution,
      timeoutMs: this.config.map.timeoutMs,
      userAgent: this.config.geocoder.userAgent,
      referer: this.config.map.referer,
      fetcher: this.config.fetcher,
    });
  }
}

export {
  ProofLocationService,
  UNAVAILABLE_RETRY_MS,
  configFromEnv as proofLocationConfigFromEnv,
};
export type { AddressResolution, ProofLocationConfig };
