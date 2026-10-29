import { readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RouteOptions } from "fastify";
import { z } from "zod";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { DATABASE_RETRY_AFTER_SECONDS } from "@/shared/errors/database-unavailable";
import { BUSINESS_API_RATE_PER_MINUTE } from "@/shared/integration/api-key-rules";
import {
  buildPublicApiDocument,
  type OpenApiDocument,
} from "@/shared/integration/public-docs";
import { openapiTransform } from "@/routes/documentation/openapi-transform";
import { normalizeTagName } from "@/routes/documentation/api-tags";
import {
  ensureApiKey,
  verifyApiScope,
} from "@/modules/middlewares/ensure-api-key";

/**
 * The internal reference (/docs) and the public one, read as their readers
 * read them: in pt-BR (decision 11.4), in described sections, with the
 * refusals of the public API where they happen (DOCS-04) and the scope each
 * keyed route demands, taken from the hook that enforces it (DOCS-05).
 */
type Json = Record<string, any>;

let app: Awaited<typeof import("@/http")>["app"];
let document: Json;
const routes: RouteOptions[] = [];

beforeAll(async () => {
  ({ app } = await import("@/http"));

  app.addHook("onRoute", (route) => {
    routes.push(route as RouteOptions);
  });

  await app.ready();

  document = app.swagger() as Json;
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await app?.close();
});

const operations = (doc: Json = document) =>
  Object.entries<Json>(doc.paths ?? {}).flatMap(([route, methods]) =>
    Object.entries<Json>(methods).map(([method, operation]) => ({
      id: `${method.toUpperCase()} ${route}`,
      route,
      method,
      operation,
    })),
  );

const openApiPath = (url: string) => url.replace(/:(\w+)/g, "{$1}");

describe("the scope a keyed route demands (DOCS-05)", () => {
  it("is published from the hook, on every route that checks one", () => {
    const scoped = routes.flatMap((route) => {
      const scopes = [route.preHandler]
        .flat()
        .map(
          (hook) =>
            (hook as { openapi?: { scope?: string } } | undefined)?.openapi
              ?.scope,
        )
        .filter((scope): scope is string => Boolean(scope));

      return scopes.length > 0 ? [{ route, scopes }] : [];
    });

    expect(scoped.length).toBeGreaterThan(0);

    for (const { route, scopes } of scoped) {
      for (const method of [route.method].flat()) {
        const operation =
          document.paths[openApiPath(route.url)]?.[
            String(method).toLowerCase()
          ];

        if (!operation) continue;

        const id = `${method} ${route.url}`;

        expect(operation["x-scopes"], id).toEqual(scopes);
        expect(operation.description, id).toContain(`\`${scopes[0]}\``);
      }
    }
  });

  it("follows the hook, not a list written next to it", () => {
    // Red before: the transform never read the scope, so a route that
    // forgot the hand-written `x-scopes` published none.
    const { schema } = openapiTransform({
      url: "/integration/v1/probe",
      schema: { response: { 200: z.object({ ok: z.boolean() }) } } as never,
      route: {
        method: "GET",
        url: "/integration/v1/probe",
        onRequest: [ensureApiKey],
        preHandler: [verifyApiScope("routes:read")],
      } as unknown as RouteOptions,
    }) as { schema: Json };

    expect(schema["x-scopes"]).toEqual(["routes:read"]);
    expect(schema.description).toContain("`routes:read`");
  });
});

describe("the refusals of the public API (DOCS-04)", () => {
  const keyed = () =>
    operations(
      buildPublicApiDocument(document as OpenApiDocument) as Json,
    ).filter(({ operation }) =>
      operation.security?.some((entry: Json) => "apiKey" in entry),
    );

  it("documents the database outage with Retry-After on every keyed route", () => {
    expect(keyed().length).toBeGreaterThan(0);

    for (const { id, operation } of keyed()) {
      const unavailable = operation.responses["503"];

      expect(unavailable, id).toBeDefined();
      expect(unavailable.headers?.["retry-after"], id).toBeDefined();
      expect(unavailable.description, id).toContain(
        `${DATABASE_RETRY_AFTER_SECONDS} s`,
      );
      expect(
        unavailable.content["application/json"].schema.required,
        id,
      ).toEqual(expect.arrayContaining(["code", "message"]));
    }
  });

  it("names the company's ceiling in the 429, as a number", () => {
    // Red before: the per-company limit (limitBusinessApiRate) was only
    // "o teto por minuto", with no number for the integrator to size by.
    for (const { id, operation } of keyed()) {
      expect(operation.responses["429"].description, id).toContain(
        String(BUSINESS_API_RATE_PER_MINUTE),
      );
    }
  });

  it("documents 401, 403, 429 and 503 on every route behind a session or a key", () => {
    const guarded = operations().filter(
      ({ operation }) => operation.security?.length,
    );
    const missing = guarded.flatMap(({ id, operation }) =>
      ["401", "403", "429", "503"]
        .filter((status) => !operation.responses[status])
        .map((status) => `${id} → ${status}`),
    );

    expect(missing).toEqual([]);
  });
});

describe("the sections of /docs (DOCS-09)", () => {
  it("declares every section an operation uses, with a description", () => {
    const declared = new Map<string, string>(
      (document.tags ?? []).map((tag: Json) => [tag.name, tag.description]),
    );
    const undeclared = operations().flatMap(({ id, operation }) =>
      (operation.tags ?? [])
        .filter((tag: string) => !declared.get(tag))
        .map((tag: string) => `${id} → ${tag}`),
    );

    expect(declared.size).toBeGreaterThan(0);
    expect(undeclared).toEqual([]);
  });

  it("spells every section in kebab-case, however the route file wrote it", () => {
    const tags = new Set(
      operations().flatMap(({ operation }) => operation.tags ?? []),
    );

    for (const tag of tags) expect(tag).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(normalizeTagName("statusChangeReason")).toBe("status-change-reason");
    expect(normalizeTagName("fuel-type")).toBe("fuel-type");
  });

  it("groups every declared section exactly once", () => {
    const grouped = (document["x-tagGroups"] as Json[]).flatMap(
      (group) => group.tags,
    );
    const declared = (document.tags as Json[]).map((tag) => tag.name);

    expect(grouped.slice().sort()).toEqual(declared.slice().sort());
    expect(new Set(grouped).size).toBe(grouped.length);
    expect(
      (document["x-tagGroups"] as Json[]).map((group) => group.name),
    ).toEqual(["Frota", "Entregas", "Administração", "Plataforma"]);
  });

  it("introduces itself in pt-BR, with the version of the package", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );

    expect(document.info.version).toBe(pkg.version);
    expect(document.info.description).toContain("Referência interna");
    expect(document.info.description).not.toMatch(/documentation/i);
  });

  it("speaks pt-BR, with accents, on every route of /docs and of the public document", () => {
    const offenders = [
      ...readerTexts(document, "/docs"),
      ...readerTexts(
        buildPublicApiDocument(document as OpenApiDocument) as Json,
        "pública",
      ),
    ].flatMap(({ where, text }) => {
      const problem = languageProblem(text);

      return problem ? [`${where} [${problem}]: ${text.slice(0, 80)}`] : [];
    });

    expect(offenders).toEqual([]);
  });

  it("catches the English and the missing accents it is meant to catch", () => {
    // Self-test: a guard that matches nothing would pass on any document.
    expect(languageProblem("Lists the user's deliveries")).toMatch(/^inglês/);
    expect(languageProblem("Application liveness probe")).toMatch(/^inglês/);
    expect(languageProblem("Envio de webhook (dead letter)")).toBeNull(); // a quoted term is not prose
    expect(languageProblem("Checks only the database")).toMatch(/^inglês/);
    expect(languageProblem("404 when the route does not exist")).toMatch(
      /^inglês/,
    );
    expect(languageProblem("Usuario nao encontrado")).toMatch(/^sem acento/);
    expect(languageProblem("Código do veiculo")).toMatch(/^sem acento/);
    expect(
      languageProblem("Usuário não encontrado: 404 USER_NOT_FOUND."),
    ).toBeNull();
    expect(
      languageProblem(
        "`deliveryId` da entrega; a paginação pagina para o passado",
      ),
    ).toBeNull();
  });
});

/**
 * Every text a reader of the reference meets: section descriptions, operation
 * summaries and descriptions, and the description of each answer.
 */
function readerTexts(doc: Json, label: string) {
  const texts: Array<{ where: string; text: string }> = [];
  const push = (where: string, text: unknown) => {
    if (typeof text === "string" && text.trim())
      texts.push({ where: `${label} ${where}`, text });
  };

  push("info", doc.info?.description);
  for (const tag of (doc.tags ?? []) as Json[])
    push(`tag ${tag.name}`, tag.description);

  for (const { id, operation } of operations(doc)) {
    push(`${id} summary`, operation.summary);
    push(`${id} description`, operation.description);

    for (const [status, response] of Object.entries<Json>(
      operation.responses ?? {},
    )) {
      push(`${id} ${status}`, response.description);
    }
  }

  return texts;
}

/**
 * English prose (an English verb opening the text, or English function words)
 * or a pt-BR word written without its accent. Code spans and error codes are
 * stripped first: `deliveryId` or USER_NOT_FOUND are identifiers, not prose.
 */
const ENGLISH_START =
  /^(Get|Gets|List|Lists|Create|Creates|Update|Updates|Delete|Deletes|Register|Registers|Unregister|Upload|Uploads|Mark|Marks|Retrieve|Retrieves|Send|Sends|Verify|Verifies|Resend|Change|Changes|Submit|Removes|Returns?|Fetch|Fetches|Search|Searches|Toggle|Toggles|Check|Checks|Set|Sets)\b/;
// Letters, not \b: in JavaScript "paginação" has a \b after "pagina".
// Words no pt-BR sentence uses; two different ones make a sentence English,
// one alone is usually a quoted term ("dead letter", "check-in").
const ENGLISH_WORDS =
  /(?<![\p{L}-])(the|of|and|to|is|are|for|with|which|only|again|failed|returns|this|that|from|when|by|its|not|does|without|against|their|probe|successfully)(?![\p{L}-])/giu;
const UNACCENTED =
  /(?<!\p{L})(nao|voce|usuarios?|veiculos?|codigos?|invalid[oa]s?|obrigatori[oa]s?|numeros?|sessao|permissao|permissoes|informacoes|operacao|configuracao|configuracoes|exclusao|criacao|atualizacao|notificacao|notificacoes|ocorrencias?|tambem|ate|ja|horario|historico|endereco|servico|servicos|manutencao|razao|disponivel|indisponivel|unico|unica|periodo|possivel|minimo|maximo|proximo|proxima|ultimo|ultima|conteudo|automatico|automatica|requisicao|requisicoes|autenticacao|autorizacao|situacao|exportacao|importacao|transacao|comprovacao|localizacao|opcoes|opcao|acao|acoes|padrao|saida|conexao|versao|area|metodo|cabecalho|negocio|funcionario)(?!\p{L})/iu;

const PT_FUNCTION_WORDS = new Set(
  "a o as os e é de da do das dos em na no nas nos um uma para por pela pelo com sem que se não ou ao à aos às já só até sua seu mais".split(
    " ",
  ),
);

const ENGLISH_VOCABULARY = new Set(
  "system health check application probe failed failures report client side metrics operational usage connection queue deliveries events send again".split(
    " ",
  ),
);

function languageProblem(raw: string): string | null {
  const text = raw
    .replace(/`[^`]*`/g, " ")
    .replace(/\b\w*_\w*\b/g, " ") // USER_NOT_FOUND, received_by
    .replace(/\b[A-Z]{2,}\b/g, " ") // FAILED, PENDING
    .replace(/https?:\/\/\S+/g, " ");

  const englishWords = new Set(
    [...text.matchAll(ENGLISH_WORDS)].map(([word]) => word.toLowerCase()),
  );

  if (ENGLISH_START.test(text.trim()))
    return `inglês: ${text.trim().split(/\s/)[0]}`;
  if (englishWords.size >= 2) return `inglês: ${[...englishWords].join(", ")}`;

  // A title with no pt-BR function word or accent and an English word in it
  // ("System health check"); "Quem pode atender" has neither.
  const words = (text.match(/\p{L}+/gu) ?? []).map((word) =>
    word.toLowerCase(),
  );

  if (
    words.length >= 3 &&
    !words.some(
      (word) => PT_FUNCTION_WORDS.has(word) || /[áàâãéêíóôõúç]/.test(word),
    ) &&
    words.some((word) => ENGLISH_VOCABULARY.has(word))
  ) {
    return "inglês: nenhuma palavra em português";
  }

  const unaccented = text.match(UNACCENTED);

  return unaccented ? `sem acento: ${unaccented[0]}` : null;
}

describe("the packages the API imports (DOCS-10)", () => {
  it("declares every one of them as a production dependency", () => {
    // @fastify/static came only through @fastify/swagger-ui: swapping or
    // removing the UI would have broken the boot in the production image,
    // which installs production dependencies only.
    const pkg = JSON.parse(
      readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
    );
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const builtins = new Set(builtinModules);

    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) walk(full);
        else if (full.endsWith(".ts")) files.push(full);
      }
    };

    walk(path.join(process.cwd(), "src"));

    const undeclared = new Set<string>();

    for (const file of files) {
      const source = readFileSync(file, "utf8");

      for (const match of source.matchAll(
        /^\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/gm,
      )) {
        const specifier = match[1] ?? match[2];

        if (!specifier || /^(\.|@\/|node:|infra\/)/.test(specifier)) continue;

        const name = specifier.startsWith("@")
          ? specifier.split("/").slice(0, 2).join("/")
          : specifier.split("/")[0];

        if (!builtins.has(name) && !declared.has(name)) undeclared.add(name);
      }
    }

    expect([...undeclared]).toEqual([]);
    expect(declared.has("@fastify/static")).toBe(true);
  });
});
