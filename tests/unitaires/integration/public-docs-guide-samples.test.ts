import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { runInNewContext } from "node:vm";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { APP_BOOT_TIMEOUT_MS } from "../../support/app-boot";

import { integrationDeliveryListSchema } from "@/schemas/integration-schema";
import {
  deliveryEventPayload,
  routeEventPayload,
} from "@/shared/integration/announce";
import {
  NODE_VERIFICATION_SAMPLE,
  PHP_VERIFICATION_SAMPLE,
  PYTHON_VERIFICATION_SAMPLE,
} from "@/shared/integration/public-docs";
import {
  ALL_TOPICS,
  TOPIC_FAMILY,
} from "@/shared/integration/webhook-catalogue";
import {
  TOPIC_PAYLOAD,
  WEBHOOK_PAYLOAD_SCHEMAS,
} from "@/shared/integration/webhook-payload-schemas";
import {
  SIGNATURE_TOLERANCE_SECONDS,
  newWebhookSecret,
  signWebhookPayload,
} from "@/shared/integration/webhook-signature";

/**
 * The web portal's guides (trajetto-ui/src/content/docs) against this API.
 *
 * The signature samples an integrator pastes are run against the signing
 * function the dispatcher uses; the numbers a guide writes by hand are
 * compared with the code that enforces them; and every error code the public
 * document publishes must be explained in the errors guide. Skipped, visibly,
 * when the web repository is not checked out next to this one.
 */
const WEB = resolve(process.cwd(), "..", "trajetto-ui");
const DOCS = join(WEB, "src", "content", "docs");
const HAS_WEB = existsSync(join(DOCS, "assinatura.mdx"));

if (!HAS_WEB) {
  // Said out loud: in this repository's CI alone the guide checks below are
  // skipped; the pinned vectors are what still ties the samples to the signer.
  console.warn(
    "[public-docs-guide-samples] trajetto-ui não está ao lado deste repositório: os exemplos dos guias não rodaram aqui; só os vetores de assinatura fixados.",
  );
}

/**
 * Test vectors produced by the signer, pinned in BOTH repositories: here the
 * signer must keep reproducing them, and the web suite runs every guide sample
 * against the same bytes. Each repository's CI checks its half on its own;
 * with both checked out, the two files are also compared.
 */
const VECTORS_FILE = resolve(
  __dirname,
  "fixtures",
  "webhook-signature-vectors.json",
);
const WEB_VECTORS_FILE = join(
  WEB,
  "tests",
  "unitaires",
  "fixtures",
  "webhook-signature-vectors.json",
);

interface SignatureVector {
  name: string;
  secret: string;
  previous_secrets: string[];
  timestamp: number;
  body: string;
  header: string;
}

const { vectors: VECTORS } = JSON.parse(readFileSync(VECTORS_FILE, "utf8")) as {
  vectors: SignatureVector[];
};

describe("the published signature vectors", () => {
  it.each(VECTORS.map((vector) => [vector.name, vector] as const))(
    "are what the signer produces (%s)",
    (_name, vector) => {
      const signed = signWebhookPayload(
        vector.secret,
        vector.body,
        new Date(vector.timestamp * 1000),
        vector.previous_secrets,
      );

      expect(signed.header).toBe(vector.header);
    },
  );

  it("cover a rotation and a body outside ASCII", () => {
    expect(VECTORS.some((vector) => vector.previous_secrets.length > 0)).toBe(
      true,
    );
    expect(
      VECTORS.some((vector) =>
        [...vector.body].some((char) => char.charCodeAt(0) > 127),
      ),
    ).toBe(true);
    expect(VECTORS.every((vector) => vector.secret.startsWith("whsec_"))).toBe(
      true,
    );
  });

  /**
   * An integrator tests their parser with the published vector. It had an
   * `api_version`, a top-level `occurred_at` and a `data.received_by` that no
   * webhook carries, and lacked `sequence` and `created_at`.
   */
  it("carry the envelope the dispatcher sends, with the data of their topic", () => {
    type Schema = { properties: Record<string, { type?: string }> };

    const schemas = WEBHOOK_PAYLOAD_SCHEMAS as Record<string, Schema>;
    const builders: Record<string, Record<string, unknown>> = {
      WebhookDocumentData: deliveryEventPayload({ id: "x" }),
      WebhookRouteData: routeEventPayload({ id: "x", code: 1 }),
    };

    for (const vector of VECTORS) {
      const body = JSON.parse(vector.body);

      // { id, sequence, topic, created_at, data }, in the dispatcher's order.
      expect(Object.keys(body), vector.name).toEqual(
        Object.keys(schemas.WebhookEnvelope.properties),
      );
      expect(ALL_TOPICS, vector.name).toContain(body.topic);
      expect(Number.isInteger(body.sequence), vector.name).toBe(true);
      expect(new Date(body.created_at).toISOString(), vector.name).toBe(
        body.created_at,
      );

      const payload = TOPIC_PAYLOAD[body.topic as keyof typeof TOPIC_PAYLOAD];
      const properties = schemas[payload].properties;

      expect(Object.keys(body.data), vector.name).toEqual(
        Object.keys(properties),
      );
      expect(Object.keys(body.data), vector.name).toEqual(
        Object.keys(builders[payload] ?? {}),
      );

      for (const [key, value] of Object.entries(body.data)) {
        if (value === null) continue;

        const type =
          properties[key].type === "integer" ? "number" : properties[key].type;

        expect(typeof value, `${vector.name}: data.${key}`).toBe(type);
      }
    }

    // One of each family, so a parser for either is covered.
    expect(
      new Set(
        VECTORS.map(
          (vector) =>
            TOPIC_FAMILY[
              JSON.parse(vector.body).topic as keyof typeof TOPIC_FAMILY
            ],
        ),
      ),
    ).toEqual(new Set(["document", "route"]));
  });

  it.runIf(HAS_WEB)(
    "are the same bytes the web suite runs the samples against",
    () => {
      expect(readFileSync(WEB_VECTORS_FILE, "utf8")).toBe(
        readFileSync(VECTORS_FILE, "utf8"),
      );
    },
  );
});

function guide(name: string): string {
  return readFileSync(join(DOCS, `${name}.mdx`), "utf8");
}

function blocks(mdx: string, language: string): string[] {
  return [
    ...mdx.matchAll(
      new RegExp("```" + language + "\\r?\\n([\\s\\S]*?)```", "g"),
    ),
  ].map((match) => match[1]);
}

function sample(language: string, marker: string): string {
  const found = blocks(guide("assinatura"), language).filter((block) =>
    block.includes(marker),
  );

  expect(found, `um exemplo ${language} com ${marker}`).toHaveLength(1);

  return found[0];
}

type Verify = (secret: string, rawBody: string, header: unknown) => boolean;

describe.runIf(HAS_WEB)("the Node.js sample of the signature guide", () => {
  const body = JSON.stringify({
    id: "evt-1",
    topic: "delivery.delivered",
    data: {},
  });

  function verifier(): Verify {
    const sandbox: Record<string, unknown> = {
      require: createRequire(`${process.cwd()}/package.json`),
      Buffer,
      Date,
      Number,
      Math,
    };

    runInNewContext(
      `${sample("js", "function verifyTrajetto")}\nthis.verify = verifyTrajetto;`,
      sandbox,
    );

    return sandbox.verify as Verify;
  }

  it("accepts a call this API signed", () => {
    const secret = newWebhookSecret();

    expect(
      verifier()(secret, body, signWebhookPayload(secret, body).header),
    ).toBe(true);
  });

  it("accepts either secret while a rotation signs with both", () => {
    const current = newWebhookSecret();
    const previous = newWebhookSecret();
    const { header } = signWebhookPayload(current, body, new Date(), [
      previous,
    ]);

    expect(verifier()(current, body, header)).toBe(true);
    expect(verifier()(previous, body, header)).toBe(true);
  });

  it("refuses a stripped prefix, a changed body and a replay", () => {
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(secret, body);
    const old = signWebhookPayload(
      secret,
      body,
      new Date(Date.now() - (SIGNATURE_TOLERANCE_SECONDS + 60) * 1000),
    );

    expect(verifier()(secret.replace(/^whsec_/, ""), body, header)).toBe(false);
    expect(verifier()(secret, `${body} `, header)).toBe(false);
    expect(verifier()(secret, body, old.header)).toBe(false);
    expect(verifier()(secret, body, undefined)).toBe(false);
  });
});

function pythonCommand(): string | null {
  for (const command of ["python3", "python"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8" });

    if (probe.status === 0 && /Python 3/.test(`${probe.stdout}${probe.stderr}`))
      return command;
  }

  return null;
}

const python = HAS_WEB ? pythonCommand() : null;

describe.runIf(python)("the Python sample of the signature guide", () => {
  it("accepts what this API signed and refuses a stripped prefix", () => {
    const body = JSON.stringify({
      id: "evt-2",
      topic: "proof.approved",
      data: {},
    });
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(secret, body);

    const script = [
      sample("python", "def verify_trajetto"),
      "import json, sys",
      "c = json.load(sys.stdin)",
      "print(json.dumps([str(verify_trajetto(s, c['body'].encode('utf-8'), c['header'])) for s in c['secrets']]))",
    ].join("\n");

    const result = spawnSync(python as string, ["-c", script], {
      input: JSON.stringify({
        body,
        header,
        secrets: [secret, secret.replace(/^whsec_/, "")],
      }),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(["True", "False"]);
  });
});

const php =
  HAS_WEB && spawnSync("php", ["-v"], { encoding: "utf8" }).status === 0
    ? "php"
    : null;

describe.runIf(php)("the PHP sample of the signature guide", () => {
  it("accepts what this API signed and refuses a stripped prefix", () => {
    const body = JSON.stringify({
      id: "evt-3",
      topic: "route.started",
      data: {},
    });
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(secret, body);

    const script = [
      sample("php", "function verifyTrajetto").replace(/^<\?php\s*/, ""),
      "$c = json_decode(stream_get_contents(STDIN), true);",
      "echo json_encode(array_map(fn ($s) => verifyTrajetto($s, $c['body'], $c['header']), $c['secrets']));",
    ].join("\n");

    const result = spawnSync(php as string, ["-r", script], {
      input: JSON.stringify({
        body,
        header,
        secrets: [secret, secret.replace(/^whsec_/, "")],
      }),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([true, false]);
  });
});

/**
 * The same three functions are printed twice: in the signature guide and in
 * the console's introduction (public-docs.ts). Both are run against the
 * signer, but a fix applied to one copy only would leave two versions live.
 */
describe.runIf(HAS_WEB)("the samples the console's introduction prints", () => {
  it("are the guide's, character for character", () => {
    const text = (code: string) => code.replace(/\r\n/g, "\n").trimEnd();

    expect(text(sample("js", "function verifyTrajetto"))).toBe(
      NODE_VERIFICATION_SAMPLE,
    );
    expect(text(sample("python", "def verify_trajetto"))).toBe(
      PYTHON_VERIFICATION_SAMPLE,
    );
    expect(text(sample("php", "function verifyTrajetto"))).toBe(
      PHP_VERIFICATION_SAMPLE,
    );
  });
});

describe.runIf(HAS_WEB)("the numbers the guides write by hand", () => {
  it("default every sample's tolerance to the signer's", () => {
    const mdx = guide("assinatura");

    for (const [pattern, language] of [
      [/toleranceSeconds = (\d+)/, "js"],
      [/tolerance: int = (\d+)/, "python"],
      [/int \$tolerance = (\d+)/, "php"],
    ] as const) {
      expect(Number(mdx.match(pattern)?.[1]), language).toBe(
        SIGNATURE_TOLERANCE_SECONDS,
      );
    }
  });

  it("use the largest page the lists accept", () => {
    const largest = integrationDeliveryListSchema.parse({
      limit: "1000000",
    }).limit;

    for (const name of ["paginacao"]) {
      for (const match of guide(name).matchAll(/limit[=", ]+(\d+)/g)) {
        expect(Number(match[1]), `${name}: ${match[0]}`).toBe(largest);
      }
    }
  });

  it("only name error codes this API sends", () => {
    const source = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);

        return statSync(path).isDirectory()
          ? source(path)
          : name.endsWith(".ts")
            ? [path]
            : [];
      });

    const code = source(resolve(process.cwd(), "src"))
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");

    const named = new Set(
      [...guide("erros").matchAll(/`([A-Z][A-Z0-9_]{3,})`/g)].map(
        (match) => match[1],
      ),
    );

    expect(named.size).toBeGreaterThan(8);

    for (const name of named) {
      expect(code.includes(`"${name}"`), name).toBe(true);
    }
  });
});

let publicDocument: Record<string, any> | null = null;
let close: (() => Promise<void>) | undefined;

beforeAll(async () => {
  if (!HAS_WEB) return;

  const { app } = await import("@/http");

  await app.ready();

  publicDocument = (
    await app.inject({ method: "GET", url: "/integration/docs/openapi.json" })
  ).json();
  close = () => app.close();
}, APP_BOOT_TIMEOUT_MS);

afterAll(async () => {
  await close?.();
});

describe.runIf(HAS_WEB)("the errors guide", () => {
  it("explains every code the public document publishes", () => {
    const published = new Set<string>();

    for (const item of Object.values(
      publicDocument!.paths as Record<string, any>,
    )) {
      for (const operation of Object.values(item) as any[]) {
        for (const [status, response] of Object.entries(
          operation.responses ?? {},
        ) as any[]) {
          if (Number(status) < 400) continue;

          const property =
            response.content?.["application/json"]?.schema?.properties?.code;

          for (const value of property?.enum ?? []) published.add(value);

          for (const match of String(property?.description ?? "").matchAll(
            /[A-Z][A-Z0-9_]{3,}/g,
          )) {
            published.add(match[0]);
          }
        }
      }
    }

    const errors = guide("erros");

    expect(published.size).toBeGreaterThan(5);

    for (const name of published) {
      expect(errors, name).toContain(`\`${name}\``);
    }
  });
});

/**
 * The web portal's tests render the reference from a copy of this document
 * (trajetto-ui/tests/unitaires/fixtures/public-openapi.json). A copy nobody
 * refreshes lets them keep passing against a shape this API no longer
 * serves; this compares it with the live document, addresses pinned the way
 * the copy has them. UPDATE_PUBLIC_OPENAPI_FIXTURE=1 rewrites it.
 */
const OPENAPI_FIXTURE = join(
  WEB,
  "tests",
  "unitaires",
  "fixtures",
  "public-openapi.json",
);

function pinnedAddresses(document: Record<string, any>): Record<string, any> {
  return {
    ...document,
    servers: [{ url: "https://api.exemplo.com.br", description: "Produção" }],
    externalDocs: {
      ...document.externalDocs,
      url: "https://www.exemplo.com.br/docs",
    },
  };
}

describe.runIf(HAS_WEB)("the web portal's copy of the public document", () => {
  it("is the document this API serves (UPDATE_PUBLIC_OPENAPI_FIXTURE=1 regenerates it)", () => {
    const live = pinnedAddresses(publicDocument!);

    if (process.env.UPDATE_PUBLIC_OPENAPI_FIXTURE === "1") {
      writeFileSync(OPENAPI_FIXTURE, JSON.stringify(live));
    }

    expect(
      JSON.parse(readFileSync(OPENAPI_FIXTURE, "utf8")),
      "cópia desatualizada: rode este teste com UPDATE_PUBLIC_OPENAPI_FIXTURE=1",
    ).toEqual(live);
  });
});
