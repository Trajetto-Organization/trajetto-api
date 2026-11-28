#!/usr/bin/env node
/**
 * A stand-in for the geocoding provider, with a contracted plan's limits
 * (plano-escala LOAD-04, the import-geocode scene).
 *
 * The harness has no provider: a load run must never reach LocationIQ (the
 * call costs the account's day, and nothing of a test may leave the
 * machine). This server answers the Nominatim-compatible `/search` the API
 * calls (shared/services/proof-location/address-geocoder.ts) with a point in
 * São Paulo for every address, after FAKE_GEOCODER_LATENCY_MS, and enforces
 * the plan the way the provider does: past FAKE_GEOCODER_PER_SECOND calls in
 * a second, or FAKE_GEOCODER_PER_DAY in the run, it answers 429 with
 * LocationIQ's own words ("Rate Limited Second", "Rate Limited Day"), which
 * the API reads as a burst or the day's quota. The defaults are the Startup
 * plan's (decision D40): 22 a second, 60 000 a day.
 *
 * GET /stats says what it answered: the scene polls it to know when every
 * row of the spreadsheet has its point (`matching`, the distinct addresses
 * answered that contain `?contains=`, the run's marker), and fails when the
 * API went past the plan (`refused` above 0). GET /health answers 200.
 *
 * Over HTTPS in the harness: the replicas run NODE_ENV=production, and
 * production refuses a REVERSE_GEOCODER_URL that is not https (env-schema).
 * With FAKE_GEOCODER_TLS_DIR, the server mints a CA of its own and a
 * certificate for FAKE_GEOCODER_HOSTS (fake-geocoder, localhost) with the
 * repository's node-forge (FAKE_GEOCODER_FORGE, mounted read-only), serves
 * with it and only then writes the CA to <dir>/ca.pem, which the replicas
 * trust by NODE_EXTRA_CA_CERTS (geocoder-startup.env). A file left by an
 * earlier run is removed first: the healthcheck waits for the new one. The
 * CA lives one run, in the harness' own volume, and is trusted nowhere
 * else. Without the variable, plain HTTP (the unit tests, a quick run).
 *
 *   node tests/load/fake-geocoder.mjs          (port FAKE_GEOCODER_PORT, 8090)
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** São Paulo's centre: every address lands within ~20 km of it. */
const CENTRE = { lat: -23.5505, lon: -46.6333 };

/** The Startup plan of LocationIQ (decision D40). */
const STARTUP = { perSecond: 22, perDay: 60_000 };

/** A stable small offset from the query, so one address keeps one point. */
function pointOf(query) {
  let hash = 2166136261;

  for (let i = 0; i < query.length; i += 1) {
    hash ^= query.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  const lat = CENTRE.lat + ((hash % 3600) - 1800) / 10_000;
  const lon = CENTRE.lon + (((hash >>> 12) % 3600) - 1800) / 10_000;

  return { lat: lat.toFixed(6), lon: lon.toFixed(6) };
}

/**
 * A CA of one run and a certificate it signs for `hosts` (and 127.0.0.1),
 * with node-forge from `forgeDir`: no openssl in the Node image.
 */
async function mintCertificate(forgeDir, hosts) {
  const { default: forge } = await import(
    pathToFileURL(resolve(forgeDir, "lib", "index.js")).href
  );
  const { pki, md } = forge;
  const notBefore = new Date(Date.now() - 60_000);
  const notAfter = new Date(Date.now() + 7 * 24 * 60 * 60_000);
  const caName = [{ name: "commonName", value: "trajetto-load fake CA" }];

  const caKeys = pki.rsa.generateKeyPair(2048);
  const ca = pki.createCertificate();

  ca.publicKey = caKeys.publicKey;
  ca.serialNumber = "01";
  ca.validity.notBefore = notBefore;
  ca.validity.notAfter = notAfter;
  ca.setSubject(caName);
  ca.setIssuer(caName);
  ca.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true, cRLSign: true },
  ]);
  ca.sign(caKeys.privateKey, md.sha256.create());

  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = "02";
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;
  cert.setSubject([{ name: "commonName", value: hosts[0] }]);
  cert.setIssuer(caName);
  cert.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        ...hosts.map((value) => ({ type: 2, value })),
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  cert.sign(caKeys.privateKey, md.sha256.create());

  return {
    ca: pki.certificateToPem(ca),
    cert: pki.certificateToPem(cert),
    key: pki.privateKeyToPem(keys.privateKey),
  };
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * The server, not yet listening; over HTTPS with `tls` ({ key, cert }).
 * `now` is the clock the plan's second is counted on (a test passes its
 * own).
 */
function createFakeGeocoder({
  perSecond = STARTUP.perSecond,
  perDay = STARTUP.perDay,
  latencyMs = 150,
  now = Date.now,
  tls = null,
} = {}) {
  const stats = {
    answered: 0,
    refused: 0,
    refusedSecond: 0,
    refusedDay: 0,
    firstAt: null,
    lastAt: null,
    maxPerSecond: 0,
    distinct: 0,
  };

  const seen = new Set();

  let second = { at: 0, count: 0 };

  /** Calls admitted in the run: the day's count (one run is one day). */
  let taken = 0;

  /** Counts the call in its second; the refusal, when the plan says so. */
  function admit(at) {
    const epochSecond = Math.floor(at / 1000);

    if (second.at !== epochSecond) second = { at: epochSecond, count: 0 };

    if (taken >= perDay) return "Rate Limited Day";
    if (second.count >= perSecond) return "Rate Limited Second";

    taken += 1;
    second.count += 1;
    stats.maxPerSecond = Math.max(stats.maxPerSecond, second.count);

    return null;
  }

  const handle = (request, response) => {
    const url = new URL(request.url ?? "/", "http://fake-geocoder");

    if (url.pathname === "/health") return send(response, 200, { ok: true });

    if (url.pathname === "/stats") {
      // This run's addresses among them: the scene's rows carry its marker.
      const contains = url.searchParams.get("contains") ?? "";
      let matching = 0;

      for (const query of seen) if (query.includes(contains)) matching += 1;

      return send(response, 200, {
        ...stats,
        matching,
        perSecond,
        perDay,
        latencyMs,
      });
    }

    if (!url.pathname.endsWith("/search")) {
      return send(response, 404, { error: "Not found" });
    }

    const at = now();
    const refusal = admit(at);

    if (refusal) {
      stats.refused += 1;

      if (refusal.endsWith("Day")) stats.refusedDay += 1;
      else stats.refusedSecond += 1;

      return send(response, 429, { error: refusal });
    }

    const query =
      url.searchParams.get("q") ??
      [url.searchParams.get("street"), url.searchParams.get("city")]
        .filter(Boolean)
        .join(", ");
    const postcode = /(\d{5})-?(\d{3})/.exec(query);
    const number = /,\s*(\d+)/.exec(query)?.[1] ?? null;

    setTimeout(() => {
      stats.answered += 1;
      stats.firstAt ??= new Date(at).toISOString();
      stats.lastAt = new Date(now()).toISOString();

      if (!seen.has(query)) {
        seen.add(query);
        stats.distinct += 1;
      }

      send(response, 200, [
        {
          ...pointOf(query),
          place_rank: number ? 30 : 26,
          category: number ? "building" : "highway",
          type: number ? "house" : "residential",
          display_name: query,
          address: {
            road: query.split(",")[0] ?? null,
            house_number: number,
            suburb: "Centro",
            city: "São Paulo",
            state: "São Paulo",
            postcode: postcode ? `${postcode[1]}-${postcode[2]}` : null,
            country_code: "br",
          },
        },
      ]);
    }, latencyMs);
  };

  return tls
    ? createTlsServer({ key: tls.key, cert: tls.cert }, handle)
    : createServer(handle);
}

export { STARTUP, createFakeGeocoder, mintCertificate, pointOf };

const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  const env = process.env;
  const port = Number(env.FAKE_GEOCODER_PORT || 8090);
  const options = {
    perSecond: Math.max(1, Number(env.FAKE_GEOCODER_PER_SECOND || 22)),
    perDay: Math.max(1, Number(env.FAKE_GEOCODER_PER_DAY || 60_000)),
    latencyMs: Math.max(0, Number(env.FAKE_GEOCODER_LATENCY_MS ?? 150)),
  };
  const tlsDir = env.FAKE_GEOCODER_TLS_DIR;
  const caFile = tlsDir ? join(tlsDir, "ca.pem") : null;

  if (caFile && existsSync(caFile)) unlinkSync(caFile);

  const tls = tlsDir
    ? await mintCertificate(
        env.FAKE_GEOCODER_FORGE || "/forge",
        (env.FAKE_GEOCODER_HOSTS || "fake-geocoder,localhost").split(","),
      )
    : null;
  const server = createFakeGeocoder({ ...options, tls });

  server.listen(port, () => {
    // The CA last: whoever waits for it finds the server already there.
    if (caFile && tls) writeFileSync(caFile, tls.ca);

    console.log(
      `fake-geocoder em ${tls ? "https" : "http"} :${port} (${options.perSecond}/s, ${options.perDay}/dia, ${options.latencyMs} ms)`,
    );
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
