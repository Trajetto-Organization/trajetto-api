#!/usr/bin/env node
/**
 * The data the staging burn-in drives, made through the API and nothing
 * else (plano-escala LOAD-09).
 *
 * Signs in as the administrator of the company 'Carga (staging)', which the
 * owner creates by hand, and makes sure that company has, for each of
 * FIXTURE_DRIVERS drivers: the driver and the driver's login, a vehicle,
 * today's route with FIXTURE_STOPS deliveries, released and started from a
 * fresh driver session (the QR code enrollment the app uses). Prints on
 * stdout the context tests/load/rolling.js reads:
 *
 *   {"baseUrl", "businessId", "managerTokens": [admin], "driverTokens": [...]}
 *
 * Everything else goes to stderr. Idempotent: what exists is found by its
 * name or plate, routes and deliveries are created with a deterministic
 * Idempotency-Key per driver and day, a driver with a route already in
 * progress keeps it, and release and start answer "unchanged" the second
 * time. Running it twice in the same window gives the same data and new
 * tokens.
 *
 * It refuses, before any write, a production host and any company whose
 * name is not exactly 'Carga (staging)': the administrator's password could
 * open a real carrier, and this script creates drivers and routes in
 * whatever company it signs into.
 *
 * Environment:
 *   FIXTURE_BASE_URL        e.g. https://api-staging.intrajetto.com (required)
 *   FIXTURE_ADMIN_EMAIL     the company administrator's e-mail (required)
 *   FIXTURE_ADMIN_PASSWORD  its password (required; never printed)
 *   FIXTURE_DRIVERS         drivers (default 12, 1 to 50)
 *   FIXTURE_STOPS           deliveries per route (default 3, 1 to 20)
 *   FIXTURE_TIMEZONE        the company's timezone, for "today" (default
 *                           America/Sao_Paulo)
 *
 * Exits 0 with the context, 2 when it refused, 1 when the API said no.
 */
import { createHash, randomBytes } from "node:crypto";

const COMPANY = "Carga (staging)";
const PRODUCTION_HOSTS = new Set([
  "api.intrajetto.com",
  "www.intrajetto.com",
  "intrajetto.com",
]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

class Refusal extends Error {}

const log = (message) => process.stderr.write(`[staging-fixture] ${message}\n`);

/**
 * Null when the URL may be written to; otherwise why not, in pt-BR. A
 * staging host (a `staging` label) or loopback (the tests' stub); never a
 * production host, whatever it is called.
 */
function targetRefusal(url) {
  let parsed;

  try {
    parsed = new URL(url ?? "");
  } catch {
    return "FIXTURE_BASE_URL ausente ou inválida.";
  }

  const host = parsed.hostname.toLowerCase();

  if (PRODUCTION_HOSTS.has(host)) {
    return `${host} é a produção: a fixture só escreve na staging.`;
  }

  if (LOOPBACK.has(host) || /(^|[.-])staging([.-]|$)/.test(host)) return null;

  return `${host} não é um host de staging (precisa de um rótulo "staging", como api-staging.intrajetto.com).`;
}

function integerIn(name, fallback, min, max) {
  const raw = process.env[name];
  const value = raw === undefined || raw === "" ? fallback : Number(raw);

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Refusal(`${name} precisa ser um inteiro de ${min} a ${max}.`);
  }

  return value;
}

/** A UUID that is always the same for the same words. */
function stableUuid(...words) {
  const hex = createHash("sha256").update(words.join(":")).digest("hex");

  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

/** A CPF the API accepts (the arithmetic of tests/support/valid-cpf.ts). */
function validCpf(base) {
  const digit = (digits, length) => {
    let sum = 0;

    for (let index = 0; index < length; index += 1) {
      sum += Number(digits[index]) * (length + 1 - index);
    }

    const rest = (sum * 10) % 11;

    return rest === 10 ? 0 : rest;
  };

  const first = digit(base, 9);

  return `${base}${first}${digit(`${base}${first}`, 10)}`;
}

const pad = (value) => String(value).padStart(2, "0");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient(baseUrl) {
  const base = baseUrl.replace(/\/+$/, "");

  /**
   * One call. 429 and 503 wait for Retry-After (the enrollment allows 8 a
   * minute per address) and try again; anything else that is not 2xx
   * throws with the status and the API's code.
   */
  async function call(method, path, { token, body, headers = {} } = {}) {
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if ((response.status === 429 || response.status === 503) && attempt < 8) {
        const seconds = Number(response.headers.get("retry-after"));
        const wait =
          Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 5000;

        log(
          `${method} ${path}: ${response.status}, de novo em ${Math.ceil(wait / 1000)} s`,
        );
        await sleep(Math.min(wait, 70_000));
        continue;
      }

      const text = await response.text();
      const type = response.headers.get("content-type") ?? "";
      const parsed = type.includes("ndjson")
        ? text
            .split("\n")
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line))
        : text
          ? JSON.parse(text)
          : null;

      if (response.status < 200 || response.status >= 300) {
        const code = parsed?.code ? ` ${parsed.code}` : "";
        const error = new Error(
          `${method} ${path}: ${response.status}${code} ${parsed?.message ?? ""}`.trim(),
        );

        error.status = response.status;
        error.code = parsed?.code;
        throw error;
      }

      return parsed;
    }
  }

  /** The items of an NDJSON listing (the `meta` line left out). */
  async function items(path, token) {
    const lines = await call("GET", path, { token });

    return (Array.isArray(lines) ? lines : []).filter(
      (line) => !("meta" in line),
    );
  }

  return { call, items };
}

const idOf = (json) => json?.data?.id ?? json?.id ?? json?.data?.route?.id;

async function main() {
  const baseUrl = process.env.FIXTURE_BASE_URL;
  const refusal = targetRefusal(baseUrl);

  if (refusal) throw new Refusal(refusal);

  const email = process.env.FIXTURE_ADMIN_EMAIL;
  const password = process.env.FIXTURE_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Refusal(
      "Defina FIXTURE_ADMIN_EMAIL e FIXTURE_ADMIN_PASSWORD (o administrador de 'Carga (staging)').",
    );
  }

  const drivers = integerIn("FIXTURE_DRIVERS", 12, 1, 50);
  const stops = integerIn("FIXTURE_STOPS", 3, 1, 20);
  const timeZone = process.env.FIXTURE_TIMEZONE || "America/Sao_Paulo";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone }).format(
    new Date(),
  );

  const { call, items } = makeClient(baseUrl);

  // ------------------------------------------------ who, and which company
  const session = await call("POST", "/user/session", {
    body: { email, password },
  });

  if (!session?.token) {
    throw new Refusal(
      session?.twoFactorVerification || session?.emailVerification
        ? "A conta pediu verificação (segundo fator ou e-mail): entre uma vez pela web, confirme o e-mail e deixe o 2FA desligado nesta conta de carga."
        : "O login não abriu sessão.",
    );
  }

  const admin = session.token;
  const me = (await call("GET", "/user/me", { token: admin }))?.user;

  if (me?.role !== "BUSINESS_ADMIN" || !me.businessId) {
    throw new Refusal("A conta não é administradora de uma empresa.");
  }

  const businessId = me.businessId;
  const company = (
    await call("GET", `/business/get-ai-usage/${businessId}`, { token: admin })
  )?.data;

  if (
    company?.corporate_reason !== COMPANY &&
    company?.fantasy_name !== COMPANY
  ) {
    throw new Refusal(
      `A conta é de outra empresa ("${company?.fantasy_name || company?.corporate_reason || "?"}"); a fixture só escreve em '${COMPANY}'.`,
    );
  }

  log(
    `empresa '${COMPANY}' (${businessId}), ${drivers} motoristas, ${stops} entregas por rota, dia ${today}`,
  );

  const query = (params) =>
    new URLSearchParams({ businessId, ...params }).toString();
  const find = async (path, search, match) =>
    (await items(`${path}?${query({ search, limit: "50" })}`, admin)).find(
      match,
    );

  /**
   * The record `match` finds, created by `create` when missing. Most of the
   * panel's creates answer only a message, so the record is searched again
   * afterwards; one still missing is an error, never a guess.
   */
  async function ensure(what, path, search, match, create) {
    const found = await find(path, search, match);

    if (found) return found;

    await create();

    const created = await find(path, search, match);

    if (!created?.id) {
      throw new Error(`${what} não apareceu na busca depois de criado.`);
    }

    return created;
  }

  // ------------------------------------------------------ shared records
  const shipperName = "Carga embarcador";
  const shipper = await ensure(
    "O embarcador",
    "/shipper/search-shipper-business",
    shipperName,
    (s) => s.name === shipperName,
    () =>
      call("POST", `/shipper/create-shipper/${businessId}`, {
        token: admin,
        body: { name: shipperName },
      }),
  );

  const fuel = await ensure(
    "O combustível",
    "/fuel-type/search-fuel-type-business",
    "Diesel",
    (f) => f.description === "Diesel",
    () =>
      call("POST", `/fuel-type/create-fuel-type/${businessId}`, {
        token: admin,
        body: { description: "Diesel" },
      }),
  );

  const driverTokens = [];

  for (let index = 1; index <= drivers; index += 1) {
    const name = `Carga motorista ${pad(index)}`;
    const plate = `CRG1A${pad(index)}`;

    // -------------------------------------------------------- the driver
    const driver = await ensure(
      `O motorista ${name}`,
      "/driver/search-driver-business",
      name,
      (d) => d.name === name,
      () =>
        call("POST", `/driver/create-driver/${businessId}`, {
          token: admin,
          body: {
            name,
            birth_date: "1990-01-01",
            cnh: `7${String(index).padStart(10, "0")}`,
            cpf: validCpf(String(312_000_000 + index * 1013)),
            rg: `90${String(index).padStart(7, "0")}`,
            cep: "01001000",
            city: "São Paulo",
            uf: "SP",
            street: "Praça da Sé",
            address_number: String(index),
            status: "ACTIVE",
            contract_type: "OWNED",
          },
        }),
    );

    // The login: no e-mail, a password nobody needs (the session comes from
    // the QR code below), so no message leaves the API.
    const login = await ensure(
      `O login de ${name}`,
      "/user/search-user-business",
      name,
      (user) => user.driverId === driver.id || user.name === name,
      () =>
        call("POST", "/user/create-user", {
          token: admin,
          body: {
            name,
            role: "BUSINESS_USER",
            businessId,
            driverId: driver.id,
            password: `Carga-${randomBytes(9).toString("base64url")}`,
            userType: "driver",
          },
        }),
    );

    // ------------------------------------------------------ the vehicle
    // The company's vehicle limit (set by the MASTER) must cover the
    // drivers; past it the API refuses with the sentence that says so.
    const vehicle = await ensure(
      `O veículo ${plate}`,
      "/vehicle/search-vehicle-business",
      plate,
      (v) => v.license_plate === plate,
      () =>
        call("POST", `/vehicle/create-vehicle/${businessId}`, {
          token: admin,
          body: {
            description: `Carga veículo ${pad(index)}`,
            license_plate: plate,
            brand: "Carga",
            model: "Furgão",
            acquisition_date: "2026-01-01",
            fleet_type: "OWNED",
            current_mileage: 1000,
            maintenance_interval_km: 10000,
            maintenance_interval_months: 6,
            renavam: `5${String(index).padStart(10, "0")}`,
            manufacturing_year: "2024",
            model_year: "2024",
            km_per_liter: 10,
            number_of_axles: 2,
            status: "ACTIVE",
            fuelTypeId: fuel.id,
          },
        }),
    );

    // -------------------------------------------- the session (QR code)
    const enrollment = await call("POST", `/user/${login.id}/enrollment`, {
      token: admin,
    });
    const driverSession = await call("POST", "/user/session/enroll", {
      body: {
        qrToken: enrollment.qrToken,
        deviceId: stableUuid("carga-staging-device", businessId, index),
      },
    });
    const token = driverSession?.token;

    if (!token) throw new Error(`A sessão de ${name} não abriu.`);

    // ------------------------------------------------------- the route
    const running = (
      await items(
        `/route/list-routes?${query({ page: "1", pageSize: "5", driverId: driver.id, status: "IN_PROGRESS" })}`,
        admin,
      )
    )[0];

    if (running) {
      log(`${name}: rota em andamento mantida`);
    } else {
      const deliveryIds = [];

      for (let stop = 1; stop <= stops; stop += 1) {
        deliveryIds.push(
          idOf(
            await call("POST", `/delivery/create-delivery/${businessId}`, {
              token: admin,
              headers: {
                "Idempotency-Key": stableUuid(
                  "carga-delivery",
                  businessId,
                  index,
                  today,
                  stop,
                ),
              },
              body: {
                shipperId: shipper.id,
                recipient_name: `Carga destinatário ${pad(index)}-${pad(stop)}`,
                cep: "01001000",
                city: "São Paulo",
                uf: "SP",
                street: "Praça da Sé",
                address_number: String(stop),
                latitude: -23.55 + index * 0.001,
                longitude: -46.63 + stop * 0.001,
                scheduled_date: today,
              },
            }),
          ),
        );
      }

      const routeId = idOf(
        await call("POST", `/route/create-route/${businessId}`, {
          token: admin,
          headers: {
            "Idempotency-Key": stableUuid(
              "carga-route",
              businessId,
              index,
              today,
            ),
          },
          body: {
            driverId: driver.id,
            vehicleId: vehicle.id,
            scheduled_date: today,
            deliveryIds,
            name: `Carga ${pad(index)}`,
          },
        }),
      );

      await call(
        "PATCH",
        `/route/release-route/${routeId}/business/${businessId}`,
        { token: admin, body: { released: true } },
      );
      await call(
        "POST",
        `/route/start-route/${routeId}/business/${businessId}`,
        { token, body: {} },
      );
      log(`${name}: rota ${routeId} em andamento`);
    }

    driverTokens.push(token);
  }

  process.stdout.write(
    `${JSON.stringify({ baseUrl, businessId, managerTokens: [admin], driverTokens })}\n`,
  );
}

main().catch((error) => {
  log(error.message);
  process.exit(error instanceof Refusal ? 2 : 1);
});
