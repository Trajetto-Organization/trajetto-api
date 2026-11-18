#!/usr/bin/env node
/**
 * A fleet of sockets: how many connect, how many drop, and how fast the
 * dropped ones come back after a restart (plano-escala LOAD-05).
 *
 * One process holds the fleet. Each socket is its own Engine.IO
 * connection (`forceNew`, never a Manager shared with another socket), as
 * each phone and each tab is, with its own token and an origin: the local
 * address it binds to (`localAddress`).
 *
 * The origins exist because of the API's handshake budgets
 * (src/shared/socket/handshake-rate-limit.ts): 300 handshakes per address
 * per minute, 30 per user per minute and 20 sockets per user on one
 * replica. A fleet from one address measures the limiter, not the
 * fleet. So every handshake, the ramp's and every reconnection after it,
 * goes through a pacer that keeps each origin below FLEET_ORIGIN_PER_MINUTE
 * (240, never 300) and each token below FLEET_TOKEN_PER_MINUTE (20, never
 * 30) in ANY 60 s, which also keeps the API's fixed windows below them.
 * IPv6 origins of the same /64 are one origin, as the API keys them.
 *
 * What a reconnection does is what the web and the app do: a refusal with
 * `retryAfterMs` (SOCKET_UNAVAILABLE, the admission of U-01) waits it out;
 * a dropped transport or any other retriable refusal waits 1 s doubling to
 * 30 s, ±50% (the web's SOCKET_RECONNECT_OPTIONS); a refusal about the
 * credential is never retried, and fails the run (the tokens are stale).
 *
 * Two modes:
 *
 * - direct (the default): the harness or a bench origin, no edge in between.
 *   It refuses production's hosts and staging's (staging only through the
 *   edge, with its own caps, or through the burn-in), and asks for at least
 *   8 origins (FLEET_MIN_ORIGINS);
 * - `--via-edge`: staging through Cloudflare and Traefik, run by hand from
 *   the VPS host like the burn-in (LOAD-09). The sockets cross the Traefik
 *   and the conntrack production uses, hence its own caps: a ramp of at most
 *   20 handshakes/s, at most 10 minutes, only 06:00–08:00 UTC (03:00–05:00
 *   BRT, never on the 1st nor on a Sunday), and at most 1,000 sockets on the
 *   single VPS (5,000 with FLEET_EDGE_TOPOLOGY=second-vps, once staging left
 *   for the second VPS, G-03). The burn-in's probes abort everything:
 *   production's readiness p95 above 2× its base or 3 failures, and the
 *   host's iowait above 20% or steal above 10%.
 *
 * Several machines or containers (one IP each) make one fleet with
 * FLEET_SHARD=i/n and the same FLEET_START_AT: each takes its share of the
 * sockets and of the tokens, and `merge` joins their summaries.
 *
 *   node tests/load/socket-fleet.mjs [--via-edge]         run
 *   node tests/load/socket-fleet.mjs plan [--via-edge]    the plan, nothing connects
 *   node tests/load/socket-fleet.mjs merge <out.json> <shard.json>...
 *
 * Environment (tests/load/README.md, "Frota de sockets"):
 *   FLEET_URL                 the API (direct: http://localhost:8080)
 *   FLEET_SOCKETS             sockets of the whole fleet (1000)
 *   FLEET_RATE                ramp, handshakes/s of the whole fleet (the
 *                             most the budgets and the mode allow)
 *   FLEET_DURATION            ramp plus hold (direct 5m; via edge 10m, at most)
 *   FLEET_SOURCE_ADDRESSES    the origins: local addresses, comma-separated
 *                             (none: the machine's default address)
 *   FLEET_MIN_ORIGINS         direct 8, via edge 1
 *   FLEET_ORIGIN_PER_MINUTE   handshakes per origin per minute (240; < 300)
 *   FLEET_TOKEN_PER_MINUTE    handshakes per token per minute (20; < 30)
 *   FLEET_SOCKETS_PER_TOKEN   at most this many sockets per token (10; ≤ 20)
 *   FLEET_CONTEXT_JSON        the tokens, as staging-fixture.mjs prints them
 *   FLEET_CONTEXT_FILE        or a file (fixtures/load-context.json of seed.ts)
 *   FLEET_SHARD, FLEET_START_AT  i/n, and the epoch ms all shards start at
 *   FLEET_RESTART_AFTER_S     a restart this long after the ramp (none)
 *   FLEET_RESTART_COMMAND     the command that restarts (none: by hand, at
 *                             the time printed)
 *   FLEET_RESTART_WINDOW_S    drops this long after the mark are the
 *                             restart's (120)
 *   FLEET_EDGE_TOPOLOGY       single-vps (1,000 sockets) or second-vps (5,000)
 *   FLEET_PROBE_URL, FLEET_PROBE_RESOLVE, FLEET_PROBE_EVERY_S,
 *   FLEET_PROBE_FLOOR_MS      the burn-in's probes, with its defaults
 *   FLEET_SUMMARY             also write the JSON summary to this file
 *
 * The JSON summary goes to stdout, everything else to stderr. Exits 0 when
 * the fleet passed, 1 when it failed, 2 when it refused to start, 3 when a
 * probe aborted it.
 */
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSocketClient } from "./lib/socket-client.mjs";

// ------------------------------------------------------------ the budgets

/** The API's budgets (handshake-rate-limit.ts), never reached. */
const API_HANDSHAKES_PER_ADDRESS = 300;
const API_HANDSHAKES_PER_USER = 30;
const API_SOCKETS_PER_USER = 20;

const WINDOW_MS = 60_000;

/** A dropped socket must be back within this (docs/slo.md: 99%). */
const RECOVERY_LIMIT_MS = 60_000;
const RECOVERY_SHARE = 0.99;

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_JITTER = 0.5;

const HANDSHAKE_TIMEOUT_MS = 20_000;

/** The edge's own caps (plano-escala LOAD-05). */
const EDGE = {
  maxRate: 20,
  maxSeconds: 600,
  sockets: { "single-vps": 1_000, "second-vps": 5_000 },
  // The load window, UTC minutes (docs/operacao/jobs.md, `load-window`).
  windowFrom: 360,
  windowTo: 480,
};

const DIRECT = { maxRate: 500, maxSockets: 30_000, minOrigins: 8 };

const PRODUCTION_HOSTS = new Set([
  "api.intrajetto.com",
  "www.intrajetto.com",
  "intrajetto.com",
]);

const STAGING_LABEL = /(^|[.-])staging([.-]|$)/;

/** Refusals that say nothing against the credential (admission.ts). */
const RETRIABLE_CODES = new Set([
  "SOCKET_UNAVAILABLE",
  "SOCKET_RATE_LIMITED",
  "SOCKET_TOO_MANY_CONNECTIONS",
]);

/** The burn-in's probes (staging-burn-in.sh), with the same numbers. */
const PROBE = {
  samples: 12,
  failures: 3,
  floorMs: 20,
  maxFloorMs: 50,
  iowait: 20,
  steal: 10,
  url: "https://api.intrajetto.com/health/readiness",
  resolve: "127.0.0.1",
  everySeconds: 5,
};

class Refusal extends Error {}

const log = (message) => process.stderr.write(`[socket-fleet] ${message}\n`);

// ------------------------------------------------------------ the plan

function integerIn(env, name, fallback, min, max) {
  const raw = env[name];

  if (raw === undefined || raw === "") return fallback;

  if (!/^\d+$/.test(raw)) {
    throw new Refusal(`${name} precisa ser um inteiro: '${raw}'.`);
  }

  const value = Number(raw);

  if (value < min || value > max) {
    throw new Refusal(`${name}=${value}: vai de ${min} a ${max}.`);
  }

  return value;
}

function secondsOf(name, text) {
  const match = /^(\d+)(s|m)$/.exec(text ?? "");

  if (!match) {
    throw new Refusal(`${name} inválida: '${text}' (use 90s ou 10m).`);
  }

  return Number(match[1]) * (match[2] === "m" ? 60 : 1);
}

/** The key the API buckets an address by: IPv4 whole, IPv6 by its /64. */
function originKey(address) {
  if (!address) return "default";

  if (isIP(address) !== 6) return address;

  const [head, tail = ""] = address.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
    : left;

  return `${groups
    .slice(0, 4)
    .map((group) => Number.parseInt(group || "0", 16).toString(16))
    .join(":")}::/64`;
}

/** Null when the target may be loaded in this mode; otherwise why not. */
function targetRefusal(url, mode) {
  let parsed;

  try {
    parsed = new URL(url);
  } catch {
    return `FLEET_URL inválida: '${url}'.`;
  }

  const host = parsed.hostname.toLowerCase();

  if (PRODUCTION_HOSTS.has(host)) {
    return `${host} é a produção: a frota nunca roda contra ela.`;
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return "FLEET_URL precisa ser http ou https.";
  }

  if (mode === "via-edge") {
    if (!STAGING_LABEL.test(host)) {
      return `${host} não é um host de staging (precisa de um rótulo "staging").`;
    }

    if (parsed.protocol !== "https:" || isIP(host.replace(/^\[|\]$/g, ""))) {
      return "Pela borda, só https e pelo nome do host (Cloudflare e Traefik).";
    }

    return null;
  }

  if (STAGING_LABEL.test(host)) {
    return `${host} é a staging: rode com --via-edge (os tetos da borda) ou pelo staging-burn-in.sh.`;
  }

  return null;
}

/**
 * Null inside the load window (06:00–08:00 UTC, ending before 08:00, never
 * on the 1st nor on a Sunday); otherwise why not.
 */
function windowRefusal(nowMs, seconds) {
  const now = new Date(nowMs);
  const minute = now.getUTCHours() * 60 + now.getUTCMinutes();
  // The probes' base (12 samples, 2 s apart) and two minutes of margin.
  const ends = minute + Math.ceil((seconds + 30) / 60) + 2;

  if (now.getUTCDay() === 0) {
    return "Domingo é a janela do histórico (docs/operacao/jobs.md): rode de segunda a sábado.";
  }

  if (now.getUTCDate() === 1) {
    return "O dia 1 é do ensaio de restauração (docs/operacao/jobs.md): rode noutro dia.";
  }

  if (minute < EDGE.windowFrom || ends > EDGE.windowTo) {
    return "Fora da janela de carga: só das 06:00 às 08:00 UTC (03:00–05:00 BRT), terminando antes das 08:00.";
  }

  return null;
}

function readContext(env, scriptDir) {
  let raw = env.FLEET_CONTEXT_JSON;

  if (!raw) {
    const file =
      env.FLEET_CONTEXT_FILE ||
      resolve(scriptDir, "fixtures", "load-context.json");

    try {
      raw = readFileSync(file, "utf8");
    } catch {
      throw new Refusal(
        `Sem tokens: defina FLEET_CONTEXT_JSON (a saída da staging-fixture.mjs) ou FLEET_CONTEXT_FILE (${file} não existe; rode o seed.ts).`,
      );
    }
  }

  let context;

  try {
    context = JSON.parse(raw);
  } catch {
    throw new Refusal("O contexto dos tokens não é JSON.");
  }

  const tokens = [
    ...(context.driverTokens ?? []),
    ...(context.managerTokens ?? []),
  ].filter((token) => typeof token === "string" && token.length > 0);

  if (tokens.length === 0) {
    throw new Refusal("O contexto não traz driverTokens nem managerTokens.");
  }

  return tokens;
}

/**
 * The validated plan of ONE shard, from the environment and the command
 * line. Throws a Refusal, in pt-BR, for anything that would break a cap,
 * spend a budget of the API or not fit the duration.
 */
function planFleet(env, { argv = [], nowMs = Date.now(), tokens } = {}) {
  const mode = argv.includes("--via-edge") ? "via-edge" : "direct";
  const edge = mode === "via-edge";

  const url = env.FLEET_URL || (edge ? "" : "http://localhost:8080");

  if (!url) throw new Refusal("Defina FLEET_URL (o host da staging).");

  const refusal = targetRefusal(url, mode);

  if (refusal) throw new Refusal(refusal);

  const topology = env.FLEET_EDGE_TOPOLOGY || "single-vps";

  if (edge && !(topology in EDGE.sockets)) {
    throw new Refusal(
      `FLEET_EDGE_TOPOLOGY=${topology}: use single-vps ou second-vps.`,
    );
  }

  const maxSockets = edge ? EDGE.sockets[topology] : DIRECT.maxSockets;
  const sockets = integerIn(env, "FLEET_SOCKETS", 1_000, 1, Infinity);

  if (sockets > maxSockets) {
    throw new Refusal(
      edge
        ? `FLEET_SOCKETS=${sockets}: pela borda ${topology === "single-vps" ? "na VPS única" : "no 2º VPS"} o teto é ${maxSockets} sockets${topology === "single-vps" ? " (5.000 só depois do G-03, com FLEET_EDGE_TOPOLOGY=second-vps)" : ""}.`
        : `FLEET_SOCKETS=${sockets}: o teto da frota é ${maxSockets}.`,
    );
  }

  const seconds = secondsOf(
    "FLEET_DURATION",
    env.FLEET_DURATION || (edge ? "10m" : "5m"),
  );

  if (edge && seconds > EDGE.maxSeconds) {
    throw new Refusal(
      `FLEET_DURATION=${env.FLEET_DURATION}: pela borda o teto é 10 minutos.`,
    );
  }

  if (edge) {
    const outside = windowRefusal(nowMs, seconds);

    if (outside) throw new Refusal(outside);
  }

  const shardMatch = /^(\d+)\/(\d+)$/.exec(env.FLEET_SHARD || "1/1");
  const shard = shardMatch ? Number(shardMatch[1]) : 0;
  const shards = shardMatch ? Number(shardMatch[2]) : 0;

  if (!shardMatch || shard < 1 || shard > shards) {
    throw new Refusal(`FLEET_SHARD inválido: '${env.FLEET_SHARD}' (use 2/8).`);
  }

  const perOrigin = integerIn(
    env,
    "FLEET_ORIGIN_PER_MINUTE",
    240,
    1,
    API_HANDSHAKES_PER_ADDRESS - 1,
  );
  const perToken = integerIn(
    env,
    "FLEET_TOKEN_PER_MINUTE",
    20,
    1,
    API_HANDSHAKES_PER_USER - 1,
  );
  const maxPerToken = integerIn(
    env,
    "FLEET_SOCKETS_PER_TOKEN",
    10,
    1,
    API_SOCKETS_PER_USER,
  );

  const addresses = [
    ...new Set(
      (env.FLEET_SOURCE_ADDRESSES || "")
        .split(",")
        .map((address) => address.trim())
        .filter(Boolean),
    ),
  ];

  for (const address of addresses) {
    if (!isIP(address)) {
      throw new Refusal(
        `FLEET_SOURCE_ADDRESSES: '${address}' não é um endereço IP.`,
      );
    }
  }

  const sources = addresses.length > 0 ? addresses : [null];
  const origins = new Set(sources.map(originKey)).size;
  const minOrigins = integerIn(
    env,
    "FLEET_MIN_ORIGINS",
    edge ? 1 : DIRECT.minOrigins,
    1,
    1_000,
  );

  if (origins * shards < minOrigins) {
    throw new Refusal(
      `${origins * shards} origem(ns) para FLEET_MIN_ORIGINS=${minOrigins}: dê endereços em FLEET_SOURCE_ADDRESSES ou rode em mais contêineres ou máquinas com FLEET_SHARD (README, "Frota de sockets").`,
    );
  }

  // This shard's share: every n-th socket and every n-th token.
  const allTokens = tokens ?? [];
  const shardTokens = allTokens.filter((_, i) => i % shards === shard - 1);
  const shardSockets =
    Math.floor(sockets / shards) + (shard - 1 < sockets % shards ? 1 : 0);

  if (shardSockets === 0) {
    throw new Refusal(`O shard ${shard}/${shards} ficaria sem sockets.`);
  }

  if (shardTokens.length === 0) {
    throw new Refusal(
      `O shard ${shard}/${shards} ficaria sem tokens (${allTokens.length} no contexto).`,
    );
  }

  const socketsPerToken = Math.ceil(shardSockets / shardTokens.length);

  if (socketsPerToken > maxPerToken) {
    throw new Refusal(
      `${shardSockets} sockets em ${shardTokens.length} tokens dão ${socketsPerToken} por token, acima de FLEET_SOCKETS_PER_TOKEN=${maxPerToken}: são precisos ${Math.ceil(shardSockets / maxPerToken)} tokens (mais motoristas no seed ou na fixture).`,
    );
  }

  // The ramp the budgets allow: every origin and every token below its
  // minute, and the mode's own cap.
  const budget = Math.min(
    (origins * perOrigin) / 60,
    (shardTokens.length * perToken) / 60,
  );
  const cap = edge ? EDGE.maxRate : DIRECT.maxRate;
  const allowed = Math.min(cap, budget * shards);
  const rate =
    env.FLEET_RATE === undefined || env.FLEET_RATE === ""
      ? allowed
      : integerIn(env, "FLEET_RATE", 0, 1, cap);

  if (rate > allowed + 1e-9) {
    throw new Refusal(
      `FLEET_RATE=${rate}: as origens e os tokens deixam no máximo ${allowed.toFixed(1)} handshakes/s (${origins * shards} origem(ns) a ${perOrigin}/min, ${allTokens.length} tokens a ${perToken}/min).`,
    );
  }

  const shardRate = rate / shards;
  const rampMs = Math.ceil((shardSockets / shardRate) * 1_000);
  const holdMs = seconds * 1_000 - rampMs;

  if (holdMs < 30_000) {
    throw new Refusal(
      `A rampa leva ${Math.ceil(rampMs / 1_000)} s e não sobram 30 s de espera em FLEET_DURATION=${seconds}s: aumente a duração ou as origens.`,
    );
  }

  const restartAfterS =
    env.FLEET_RESTART_AFTER_S === undefined || env.FLEET_RESTART_AFTER_S === ""
      ? null
      : integerIn(env, "FLEET_RESTART_AFTER_S", 0, 0, 3_600);
  const restartWindowS = integerIn(env, "FLEET_RESTART_WINDOW_S", 120, 10, 300);

  if (restartAfterS !== null) {
    // Every dropped socket needs its minute after the window...
    const needed = (restartAfterS + restartWindowS) * 1_000 + RECOVERY_LIMIT_MS;

    if (holdMs < needed) {
      throw new Refusal(
        `O restart em ${restartAfterS} s, a janela de ${restartWindowS} s e o minuto da volta pedem ${Math.ceil(needed / 1_000)} s de espera; sobram ${Math.floor(holdMs / 1_000)} s: aumente FLEET_DURATION.`,
      );
    }

    // ...and the whole shard must fit one minute of every budget to be
    // back in it, or the pacer itself would hold sockets past 60 s.
    if (shardSockets > origins * perOrigin) {
      throw new Refusal(
        `A volta em ≤ 60 s de ${shardSockets} sockets pede ${Math.ceil(shardSockets / perOrigin)} origens a ${perOrigin}/min neste shard; há ${origins}.`,
      );
    }

    if (socketsPerToken > perToken) {
      throw new Refusal(
        `${socketsPerToken} sockets por token não voltam em um minuto a ${perToken} handshakes/min por token.`,
      );
    }
  }

  const startAtMs =
    env.FLEET_START_AT === undefined || env.FLEET_START_AT === ""
      ? nowMs + 1_000
      : integerIn(env, "FLEET_START_AT", 0, 0, Number.MAX_SAFE_INTEGER);

  const reconnectBaseMs = integerIn(
    env,
    "FLEET_RECONNECT_BASE_MS",
    RECONNECT_BASE_MS,
    100,
    RECONNECT_MAX_MS,
  );

  return {
    mode,
    url,
    topology: edge ? topology : null,
    shard,
    shards,
    sockets,
    shardSockets,
    rate,
    shardRate,
    rampMs,
    holdMs,
    startAtMs,
    endAtMs: startAtMs + seconds * 1_000,
    restartAtMs:
      restartAfterS === null
        ? null
        : startAtMs + rampMs + restartAfterS * 1_000,
    restartWindowMs: restartWindowS * 1_000,
    restartCommand: env.FLEET_RESTART_COMMAND || null,
    sources,
    origins,
    minOrigins,
    perOrigin,
    perToken,
    tokens: shardTokens,
    socketsPerToken,
    reconnectBaseMs,
    handshakeTimeoutMs: HANDSHAKE_TIMEOUT_MS,
    probes: edge,
  };
}

// ------------------------------------------------------------ the pacer

/**
 * Hands out handshake slots: none before its time, and never one that
 * would take an origin or a token to its minute's budget in ANY 60 s.
 * A sliding window over the last minute's grants, so the API's fixed
 * windows, which are inside it, stay below too.
 */
function createPacer({ perOrigin, perToken, now }) {
  const grants = new Map();
  const queue = [];
  let timer = null;

  const recent = (key, at) => {
    const list = grants.get(key) ?? [];

    while (list.length > 0 && list[0] <= at - WINDOW_MS) list.shift();

    grants.set(key, list);

    return list;
  };

  const readyAt = (entry, at) => {
    let ready = Math.max(at, entry.notBefore);

    for (const [key, budget] of [
      [`o:${entry.origin}`, perOrigin],
      [`t:${entry.token}`, perToken],
    ]) {
      const list = recent(key, at);

      if (list.length >= budget) {
        ready = Math.max(ready, list[list.length - budget] + WINDOW_MS);
      }
    }

    return ready;
  };

  function pump() {
    timer = null;

    const at = now();
    let earliest = Infinity;

    for (let i = 0; i < queue.length;) {
      const entry = queue[i];
      const ready = readyAt(entry, at);

      if (ready <= at) {
        queue.splice(i, 1);
        recent(`o:${entry.origin}`, at).push(at);
        recent(`t:${entry.token}`, at).push(at);
        entry.resolve(true);
        continue;
      }

      earliest = Math.min(earliest, ready);
      i += 1;
    }

    if (queue.length > 0) {
      timer = setTimeout(pump, Math.max(1, earliest - at));
    }
  }

  return {
    acquire(entry) {
      return new Promise((done) => {
        queue.push({ ...entry, resolve: done });

        if (timer) clearTimeout(timer);

        pump();
      });
    },
    stop() {
      if (timer) clearTimeout(timer);

      timer = null;

      for (const entry of queue.splice(0)) entry.resolve(false);
    },
  };
}

// ------------------------------------------------------------ the numbers

function percentile(values, p) {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/** The most attempts any origin made in one sliding minute. */
function maxPerMinute(attempts) {
  const byOrigin = new Map();

  for (const { origin, atMs } of attempts) {
    byOrigin.set(origin, [...(byOrigin.get(origin) ?? []), atMs]);
  }

  let max = 0;

  for (const times of byOrigin.values()) {
    times.sort((a, b) => a - b);

    for (let start = 0, end = 0; end < times.length; end += 1) {
      while (times[end] - times[start] >= WINDOW_MS) start += 1;

      max = Math.max(max, end - start + 1);
    }
  }

  return max;
}

/** Why a handshake failed: the refusal's code, or the transport. */
function refusalOf(error) {
  const code = error?.data?.code;

  if (typeof code === "string") {
    if (code === "SOCKET_UNAVAILABLE") return "unavailable";
    if (code === "SOCKET_RATE_LIMITED") return "rateLimited";
    if (code === "SOCKET_TOO_MANY_CONNECTIONS") return "tooManyConnections";

    return "credential";
  }

  // socket.io-client's own: a transport that failed, or the timeout.
  if (error?.type === "TransportError" || error?.message === "timeout") {
    return "transport";
  }

  // A middleware error without a code: the token's ("Token inválido").
  return "credential";
}

/**
 * The verdict of a summary, one shard's or the merged fleet's: one line
 * per criterion, each with its limit and what was measured.
 */
function judge(summary) {
  const { sockets, handshakes, origins, drops, recovery, restart } = summary;
  const criteria = [];
  const add = (name, limit, measured, pass) =>
    criteria.push({ name, limit, measured, pass });

  add(
    "sockets conectados",
    `${sockets.planned}`,
    sockets.connected,
    sockets.connected === sockets.planned,
  );
  add(
    "recusas de credencial",
    "0",
    handshakes.refusals.credential,
    handshakes.refusals.credential === 0,
  );

  const limiter =
    handshakes.refusals.rateLimited + handshakes.refusals.tooManyConnections;

  add("recusas pelos limites de handshake", "0", limiter, limiter === 0);
  add(
    "handshakes por origem num minuto",
    `< ${API_HANDSHAKES_PER_ADDRESS}`,
    origins.maxPerMinute,
    origins.maxPerMinute < API_HANDSHAKES_PER_ADDRESS,
  );
  add(
    "origens",
    `≥ ${origins.minimum}`,
    origins.count,
    origins.count >= origins.minimum,
  );
  add("quedas fora do restart", "0", drops.unexpected, drops.unexpected === 0);

  if (restart) {
    add(
      "o restart derrubou sockets",
      "≥ 1",
      drops.duringRestart,
      drops.duringRestart >= 1,
    );
  }

  if (drops.total > 0) {
    add(
      "de volta em ≤ 60 s",
      `≥ ${Math.round(RECOVERY_SHARE * 100)}%`,
      `${(recovery.share * 100).toFixed(1)}%`,
      recovery.share >= RECOVERY_SHARE,
    );
  }

  if (summary.aborted) add("sondas", "nenhuma aborta", summary.aborted, false);

  return { pass: criteria.every((criterion) => criterion.pass), criteria };
}

/** The summary of the raw numbers, judged. */
function summarize(raw) {
  const handshakeMs = raw.samples.handshakeMs;
  const dropList = raw.samples.drops;
  const recovered = dropList.filter(
    (drop) =>
      drop.recoveredAfterMs !== null &&
      drop.recoveredAfterMs <= RECOVERY_LIMIT_MS,
  );
  const recoveryMs = dropList
    .map((drop) => drop.recoveredAfterMs)
    .filter((ms) => ms !== null);
  const reasons = {};

  for (const drop of dropList) {
    reasons[drop.reason] = (reasons[drop.reason] ?? 0) + 1;
  }

  const summary = {
    scene: "socket-fleet",
    version: 1,
    mode: raw.mode,
    target: raw.target,
    topology: raw.topology,
    shards: raw.shards,
    hosts: raw.hosts,
    startedAt: new Date(raw.startedAtMs).toISOString(),
    endedAt: new Date(raw.endedAtMs).toISOString(),
    plan: raw.plan,
    origins: {
      count: raw.origins,
      minimum: raw.minOrigins,
      maxPerMinute: raw.maxPerMinute,
      budgetPerMinute: raw.perOrigin,
    },
    sockets: {
      planned: raw.planned,
      connected: raw.connected,
      neverConnected: raw.planned - raw.connected,
    },
    handshakes: {
      attempts: raw.attempts,
      p50Ms: percentile(handshakeMs, 0.5),
      p95Ms: percentile(handshakeMs, 0.95),
      p99Ms: percentile(handshakeMs, 0.99),
      maxMs: handshakeMs.length ? Math.max(...handshakeMs) : null,
      refusals: raw.refusals,
    },
    drops: {
      total: dropList.length,
      duringRestart: dropList.filter((drop) => drop.duringRestart).length,
      unexpected: dropList.filter((drop) => !drop.duringRestart).length,
      reasons,
    },
    recovery: {
      count: recoveryMs.length,
      within60s: recovered.length,
      share: dropList.length ? recovered.length / dropList.length : 1,
      p95Ms: percentile(recoveryMs, 0.95),
      maxMs: recoveryMs.length ? Math.max(...recoveryMs) : null,
      notRecovered: dropList.length - recoveryMs.length,
    },
    restart: raw.restart,
    aborted: raw.aborted,
    samples: raw.samples,
  };

  return { ...summary, verdict: judge(summary) };
}

const EMPTY_REFUSALS = () => ({
  unavailable: 0,
  rateLimited: 0,
  tooManyConnections: 0,
  credential: 0,
  transport: 0,
});

/**
 * Joins the summaries of the shards of one fleet into the fleet's own.
 * Refuses a set that is not one fleet: different targets or modes, a
 * shard missing or twice, two shards on one host with its default address
 * (one IP counted as two origins).
 */
function mergeSummaries(summaries) {
  if (summaries.length === 0) throw new Refusal("Nenhum resumo para juntar.");

  const [first] = summaries;
  const total = Number(first.shards[0].split("/")[1]);
  const seen = new Set();

  for (const summary of summaries) {
    if (summary.scene !== "socket-fleet" || summary.version !== 1) {
      throw new Refusal("Um dos arquivos não é um resumo do socket-fleet.");
    }

    if (summary.target !== first.target || summary.mode !== first.mode) {
      throw new Refusal("Os resumos são de alvos ou modos diferentes.");
    }

    for (const shard of summary.shards) {
      if (Number(shard.split("/")[1]) !== total || seen.has(shard)) {
        throw new Refusal(`O shard ${shard} não fecha uma frota de ${total}.`);
      }

      seen.add(shard);
    }
  }

  if (seen.size !== total) {
    throw new Refusal(`Faltam shards: ${seen.size} de ${total}.`);
  }

  const defaultHosts = summaries
    .filter((summary) => summary.plan.sources.includes(null))
    .flatMap((summary) => summary.hosts);

  if (new Set(defaultHosts).size !== defaultHosts.length) {
    throw new Refusal(
      "Dois shards no mesmo host com o endereço padrão são uma origem só: um shard por contêiner ou máquina, ou FLEET_SOURCE_ADDRESSES em cada um.",
    );
  }

  const refusals = EMPTY_REFUSALS();

  for (const summary of summaries) {
    for (const key of Object.keys(refusals)) {
      refusals[key] += summary.handshakes.refusals[key] ?? 0;
    }
  }

  const sum = (pick) =>
    summaries.reduce((total, summary) => total + pick(summary), 0);

  return summarize({
    mode: first.mode,
    target: first.target,
    topology: first.topology,
    shards: [...seen].sort(),
    hosts: summaries.flatMap((summary) => summary.hosts),
    startedAtMs: Math.min(...summaries.map((s) => Date.parse(s.startedAt))),
    endedAtMs: Math.max(...summaries.map((s) => Date.parse(s.endedAt))),
    plan: { ...first.plan, shardSockets: undefined },
    origins: sum((summary) => summary.origins.count),
    minOrigins: first.origins.minimum,
    maxPerMinute: Math.max(...summaries.map((s) => s.origins.maxPerMinute)),
    perOrigin: first.origins.budgetPerMinute,
    planned: sum((summary) => summary.sockets.planned),
    connected: sum((summary) => summary.sockets.connected),
    attempts: sum((summary) => summary.handshakes.attempts),
    refusals,
    restart: first.restart,
    aborted: summaries.map((s) => s.aborted).find(Boolean) ?? null,
    samples: {
      handshakeMs: summaries.flatMap((s) => s.samples.handshakeMs),
      drops: summaries.flatMap((s) => s.samples.drops),
    },
  });
}

// ------------------------------------------------------------ the probes

/** p95 of the last `samples` readiness answers that were 200. */
function readinessP95(log, samples = PROBE.samples) {
  return percentile(
    log
      .filter((sample) => sample.status === 200)
      .slice(-samples)
      .map((sample) => sample.ms),
    0.95,
  );
}

/** The abort limit: twice the base, never under the floor. */
function readinessLimit(baseP95, floorMs = PROBE.floorMs) {
  return Math.max(baseP95 * 2, floorMs);
}

/**
 * The host's iowait and steal between two readings of /proc/stat, in
 * percent of the CPU time that passed, `{ iowait, steal }`: the numbers
 * vmstat prints in its `wa` and `st` columns, read from where vmstat reads
 * them. /proc/stat is the host's in a container too, so the fleet runs in
 * a Node container on the VPS host without procps. Null when either
 * reading has no `cpu` line or no time passed.
 */
function cpuPressure(before, after) {
  const counters = (text) => {
    const line = (text ?? "").split("\n").find((row) => row.startsWith("cpu "));

    // user nice system idle iowait irq softirq steal (guest is in user).
    return line ? line.trim().split(/\s+/).slice(1, 9).map(Number) : null;
  };

  const a = counters(before);
  const b = counters(after);

  if (!a || !b || a.some(Number.isNaN) || b.some(Number.isNaN)) return null;

  const delta = b.map((value, i) => value - (a[i] ?? 0));
  const total = delta.reduce((sum, value) => sum + value, 0);

  if (total <= 0) return null;

  return {
    iowait: Math.round(((delta[4] ?? 0) / total) * 100),
    steal: Math.round(((delta[7] ?? 0) / total) * 100),
  };
}

/** One readiness sample, `{ status, ms }`, through the host's own edge. */
function readinessSample(url, resolveTo) {
  const target = new URL(url);
  const client = target.protocol === "https:" ? https : http;
  const family = isIP(resolveTo ?? "") || 4;
  const lookup = resolveTo
    ? (_host, options, callback) =>
        options?.all
          ? callback(null, [{ address: resolveTo, family }])
          : callback(null, resolveTo, family)
    : undefined;

  return new Promise((done) => {
    const started = performance.now();
    const request = client.get(
      target,
      { timeout: 5_000, lookup, servername: target.hostname },
      (response) => {
        response.resume();
        response.on("end", () =>
          done({
            status: response.statusCode ?? 0,
            ms: Math.round(performance.now() - started),
          }),
        );
      },
    );

    request.on("timeout", () => request.destroy(new Error("timeout")));
    request.on("error", () => done({ status: 0, ms: 5_000 }));
  });
}

/**
 * The burn-in's two probes, as one object: `base()` before the fleet
 * (refuses when production already fails), then `check()` every few
 * seconds, which answers the reason to abort, or null.
 */
function createProbes(
  env,
  {
    sample = readinessSample,
    readStat = () => readFileSync("/proc/stat", "utf8"),
    sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  } = {},
) {
  const url = env.FLEET_PROBE_URL || PROBE.url;
  const resolveTo =
    env.FLEET_PROBE_RESOLVE === undefined
      ? PROBE.resolve
      : env.FLEET_PROBE_RESOLVE;
  const everySeconds = integerIn(
    env,
    "FLEET_PROBE_EVERY_S",
    PROBE.everySeconds,
    1,
    60,
  );
  const floorMs = integerIn(
    env,
    "FLEET_PROBE_FLOOR_MS",
    PROBE.floorMs,
    0,
    PROBE.maxFloorMs,
  );
  const samples = [];
  let limit = null;
  let lastStat = null;

  return {
    everyMs: everySeconds * 1_000,
    async base() {
      const base = [];

      for (let i = 0; i < PROBE.samples; i += 1) {
        base.push(await sample(url, resolveTo));

        if (i < PROBE.samples - 1) await sleep(2_000);
      }

      if (base.some((one) => one.status !== 200)) {
        throw new Refusal(
          `a readiness da produção já falha antes da carga: não comece (${base.map((one) => one.status).join(" ")}).`,
        );
      }

      const p95 = readinessP95(base);

      limit = readinessLimit(p95, floorMs);

      lastStat = readStat();

      return { p95, limit };
    },
    async check() {
      samples.push(await sample(url, resolveTo));

      const failures = samples.filter((one) => one.status !== 200).length;

      if (failures >= PROBE.failures) {
        return `a readiness da produção falhou ${failures} vezes.`;
      }

      if (samples.filter((one) => one.status === 200).length >= 4) {
        const p95 = readinessP95(samples);

        if (p95 > limit) {
          return `a readiness da produção subiu para p95 ${p95} ms (teto ${limit} ms).`;
        }
      }

      // Since the last check, as `vmstat <every>` samples: never the
      // average since boot.
      const stat = readStat();
      const pressure = cpuPressure(lastStat, stat);

      lastStat = stat;

      if (pressure && pressure.iowait > PROBE.iowait) {
        return `iowait do host em ${pressure.iowait}% (teto ${PROBE.iowait}%).`;
      }

      if (pressure && pressure.steal > PROBE.steal) {
        return `steal do host em ${pressure.steal}% (teto ${PROBE.steal}%).`;
      }

      return null;
    },
    stop() {},
  };
}

// ------------------------------------------------------------ the fleet

/**
 * Runs one shard of the fleet to its end and answers its summary.
 *
 * `io` is socket.io-client's; `probes` (via edge) is createProbes'. The
 * plan comes from planFleet, which is what refuses: this trusts it.
 */
async function runFleet(
  plan,
  {
    io,
    now = Date.now,
    random = Math.random,
    probes = null,
    restart = (command) =>
      spawn(command, { shell: true, stdio: ["ignore", 2, 2] }),
    say = log,
  },
) {
  const pacer = createPacer({
    perOrigin: plan.perOrigin,
    perToken: plan.perToken,
    now,
  });
  const timers = new Set();
  const attempts = [];
  const handshakeMs = [];
  const drops = [];
  const refusals = EMPTY_REFUSALS();
  let stopped = false;
  let aborted = null;

  const later = (ms, task) => {
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        task();
      },
      Math.max(0, ms),
    );

    timers.add(timer);
  };

  const backoff = (retries) =>
    Math.min(plan.reconnectBaseMs * 2 ** retries, RECONNECT_MAX_MS) *
    (1 - RECONNECT_JITTER + random() * RECONNECT_JITTER * 2);

  const duringRestart = (atMs) =>
    plan.restartAtMs !== null &&
    atMs >= plan.restartAtMs &&
    atMs <= plan.restartAtMs + plan.restartWindowMs;

  const members = Array.from({ length: plan.shardSockets }, (_, index) => {
    const address = plan.sources[index % plan.sources.length];

    return {
      index,
      address,
      origin: originKey(address),
      tokenIndex: index % plan.tokens.length,
      connectedOnce: false,
      failed: false,
      retries: 0,
      openDrop: null,
      socket: null,
    };
  });

  async function attempt(member, notBefore) {
    if (stopped || member.failed) return;

    const granted = await pacer.acquire({
      origin: member.origin,
      token: member.tokenIndex,
      notBefore,
    });

    if (!granted || stopped) return;

    const startedAt = now();

    attempts.push({ origin: member.origin, atMs: startedAt });

    const socket = io(plan.url, {
      forceNew: true,
      reconnection: false,
      transports: ["websocket"],
      timeout: plan.handshakeTimeoutMs,
      auth: { token: plan.tokens[member.tokenIndex] },
      ...(member.address ? { localAddress: member.address } : {}),
    });

    member.socket = socket;

    const retire = () => {
      socket.removeAllListeners();
      socket.close();

      if (member.socket === socket) member.socket = null;
    };

    socket.on("connect", () => {
      handshakeMs.push(now() - startedAt);
      member.connectedOnce = true;
      member.retries = 0;

      if (member.openDrop) {
        member.openDrop.recoveredAfterMs = now() - member.openDrop.atMs;
        member.openDrop = null;
      }
    });

    socket.on("connect_error", (error) => {
      retire();

      if (stopped) return;

      const kind = refusalOf(error);

      refusals[kind] += 1;

      if (kind === "credential") {
        member.failed = true;
        say(`token ${member.tokenIndex} recusado: ${error?.message}`);
        return;
      }

      const retryAfterMs = Number(error?.data?.retryAfterMs);
      const wait =
        RETRIABLE_CODES.has(error?.data?.code) && retryAfterMs > 0
          ? retryAfterMs
          : backoff(member.retries);

      member.retries += 1;
      later(wait, () => attempt(member, 0));
    });

    socket.on("disconnect", (reason) => {
      retire();

      if (stopped || reason === "io client disconnect") return;

      const atMs = now();

      if (!member.openDrop) {
        member.openDrop = {
          atMs,
          duringRestart: duringRestart(atMs),
          reason,
          recoveredAfterMs: null,
        };
        drops.push(member.openDrop);
      }

      const wait = backoff(member.retries);

      member.retries += 1;
      later(wait, () => attempt(member, 0));
    });
  }

  const startedAtMs = now();

  say(
    `${plan.shardSockets} sockets (shard ${plan.shard}/${plan.shards}) em ${plan.url}: rampa de ${(plan.rampMs / 1_000).toFixed(0)} s a ${plan.shardRate.toFixed(1)}/s, ${plan.origins} origem(ns), ${plan.tokens.length} tokens.`,
  );

  if (plan.restartAtMs !== null) {
    say(
      `restart às ${new Date(plan.restartAtMs).toISOString()}${plan.restartCommand ? "" : ": reinicie à mão nessa hora"}.`,
    );
  }

  const ended = new Promise((done) => {
    const finish = () => done();
    const untilEnd = Math.max(0, plan.endAtMs - now());

    later(untilEnd, finish);

    if (probes) {
      const tick = async () => {
        if (stopped) return;

        const reason = await probes.check();

        if (reason && !stopped) {
          aborted = reason;
          say(`ABORTADO: ${reason}`);
          finish();
          return;
        }

        later(probes.everyMs, tick);
      };

      later(probes.everyMs, tick);
    }
  });

  members.forEach((member, index) => {
    const notBefore =
      plan.startAtMs + Math.floor((index * 1_000) / plan.shardRate);

    attempt(member, notBefore);
  });

  if (plan.restartAtMs !== null && plan.restartCommand) {
    later(plan.restartAtMs - now(), () => {
      say(`restart: ${plan.restartCommand}`);
      restart(plan.restartCommand);
    });
  }

  await ended;

  stopped = true;
  pacer.stop();
  probes?.stop();

  for (const timer of timers) clearTimeout(timer);

  for (const member of members) {
    member.socket?.removeAllListeners();
    member.socket?.close();
  }

  return summarize({
    mode: plan.mode,
    target: plan.url,
    topology: plan.topology,
    shards: [`${plan.shard}/${plan.shards}`],
    hosts: [hostname()],
    startedAtMs,
    endedAtMs: now(),
    plan: {
      sockets: plan.sockets,
      shardSockets: plan.shardSockets,
      ratePerSecond: plan.rate,
      rampSeconds: Math.round(plan.rampMs / 1_000),
      holdSeconds: Math.round(plan.holdMs / 1_000),
      sources: plan.sources,
      socketsPerToken: plan.socketsPerToken,
    },
    origins: plan.origins,
    minOrigins: plan.minOrigins,
    maxPerMinute: maxPerMinute(attempts),
    perOrigin: plan.perOrigin,
    planned: plan.shardSockets,
    connected: members.filter((member) => member.connectedOnce).length,
    attempts: attempts.length,
    refusals,
    restart:
      plan.restartAtMs === null
        ? null
        : {
            at: new Date(plan.restartAtMs).toISOString(),
            windowSeconds: plan.restartWindowMs / 1_000,
            command: Boolean(plan.restartCommand),
          },
    aborted,
    samples: { handshakeMs, drops },
  });
}

// ------------------------------------------------------------ the command

/** The plan, without the tokens, to print. */
const printable = ({ tokens, ...plan }) => ({
  ...plan,
  tokens: tokens.length,
  startAt: new Date(plan.startAtMs).toISOString(),
  restartAt: plan.restartAtMs ? new Date(plan.restartAtMs).toISOString() : null,
});

function emit(summary, env) {
  const text = `${JSON.stringify(summary, null, 2)}\n`;

  if (env.FLEET_SUMMARY) writeFileSync(env.FLEET_SUMMARY, text);

  process.stdout.write(text);

  for (const criterion of summary.verdict.criteria) {
    log(
      `${criterion.pass ? "ok " : "REPROVADO"} ${criterion.name}: ${criterion.measured} (limite ${criterion.limit})`,
    );
  }
}

async function main(argv, env) {
  const scriptDir = fileURLToPath(new URL(".", import.meta.url));

  if (argv[0] === "merge") {
    const [out, ...inputs] = argv.slice(1);

    if (!out || inputs.length === 0) {
      throw new Refusal(
        "uso: node tests/load/socket-fleet.mjs merge <saída.json> <shard.json>...",
      );
    }

    const merged = mergeSummaries(
      inputs.map((file) => JSON.parse(readFileSync(file, "utf8"))),
    );

    emit(merged, { ...env, FLEET_SUMMARY: out });

    return merged.verdict.pass ? 0 : 1;
  }

  const tokens = readContext(env, scriptDir);
  const edge = argv.includes("--via-edge");

  if (argv[0] === "plan") {
    const plan = planFleet(env, { argv, tokens });

    process.stdout.write(`${JSON.stringify(printable(plan), null, 2)}\n`);

    return 0;
  }

  // Validated before anything is measured, then again with the time the
  // fleet really starts at.
  planFleet(env, { argv, tokens });

  let probes = null;

  if (edge) {
    try {
      readFileSync("/proc/stat", "utf8");
    } catch {
      throw new Refusal(
        "Sem /proc/stat para a sonda do host: rode no host da VPS (Linux).",
      );
    }

    probes = createProbes(env);

    const { p95, limit } = await probes.base();

    log(
      `base da readiness da produção: p95 ${p95} ms; aborta acima de ${limit} ms ou com 3 falhas.`,
    );
  }

  const plan = planFleet(env, { argv, tokens });
  const io = await loadSocketClient();
  const summary = await runFleet(plan, { io, probes });

  emit(summary, env);

  if (summary.aborted) return 3;

  return summary.verdict.pass ? 0 : 1;
}

export {
  API_HANDSHAKES_PER_ADDRESS,
  API_HANDSHAKES_PER_USER,
  API_SOCKETS_PER_USER,
  EDGE,
  Refusal,
  createPacer,
  createProbes,
  cpuPressure,
  judge,
  maxPerMinute,
  mergeSummaries,
  originKey,
  percentile,
  planFleet,
  readinessLimit,
  readinessP95,
  refusalOf,
  runFleet,
  summarize,
  targetRefusal,
  windowRefusal,
};

const invokedDirectly =
  Boolean(process.argv[1]) &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedDirectly) {
  main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    (error) => {
      if (error instanceof Refusal) {
        log(error.message);
        process.exit(2);
      }

      log(error?.stack ?? String(error));
      process.exit(1);
    },
  );
}
