import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";

import { describe, expect, it } from "vitest";

import {
  NODE_VERIFICATION_SAMPLE,
  PYTHON_VERIFICATION_SAMPLE,
  buildPublicApiDocument,
} from "@/shared/integration/public-docs";
import {
  newWebhookSecret,
  signWebhookPayload,
} from "@/shared/integration/webhook-signature";

/**
 * How an integrator verifies a call, as the public reference teaches it.
 *
 * The page said "com o segredo do endpoint" and nothing else. The key is the
 * WHOLE secret, `whsec_` prefix included; integrators used to other platforms
 * strip the prefix (or decode the rest) and every verification fails
 * (DLVB-26). The Node sample below is run against a signature this API
 * produced, so the page cannot teach code that does not verify.
 */
const description = String(
  (buildPublicApiDocument({}).info as { description: string }).description,
);

type Verify = (secret: string, rawBody: string, header: string) => boolean;

/** The published sample, executed as an integrator would paste it. */
function publishedVerifier(): Verify {
  const sandbox: Record<string, unknown> = {
    require: createRequire(`${process.cwd()}/package.json`),
    Buffer,
    Date,
    Number,
    Math,
  };

  runInNewContext(
    `${NODE_VERIFICATION_SAMPLE}\nthis.verify = verifyTrajetto;`,
    sandbox,
  );

  return sandbox.verify as Verify;
}

describe("the signing key the reference names", () => {
  it("is the whole secret with its whsec_ prefix, as UTF-8", () => {
    expect(description).toMatch(/segredo INTEIRO/);
    expect(description).toMatch(/prefixo\s+`whsec_` incluído/);
    expect(description).toMatch(/Não remova o prefixo/);
  });

  it("comes with samples in Node, PHP and Python", () => {
    expect(description).toContain("```js");
    expect(description).toContain("```php");
    expect(description).toContain("```python");
    expect(description).toContain(NODE_VERIFICATION_SAMPLE);
  });

  it("says a local receiver needs an https tunnel", () => {
    expect(description).toMatch(/túnel https/);
  });

  it("names the wildcards that stand for a whole family", () => {
    expect(description).toMatch(
      /`delivery\.\*`, `occurrence\.\*`, `proof\.\*`/,
    );
    expect(description).not.toMatch(/document\.\*/);
  });
});

describe("the published Node sample", () => {
  const body = JSON.stringify({
    id: "evt-1",
    topic: "delivery.delivered",
    data: {},
  });

  it("accepts a call this API signed", () => {
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(secret, body);

    expect(publishedVerifier()(secret, body, header)).toBe(true);
  });

  it("fails for whoever strips the whsec_ prefix, which is why the page warns", () => {
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(secret, body);

    expect(
      publishedVerifier()(secret.replace(/^whsec_/, ""), body, header),
    ).toBe(false);
  });

  it("accepts either secret during a rotation, and refuses a changed body", () => {
    const current = newWebhookSecret();
    const previous = newWebhookSecret();
    const { header } = signWebhookPayload(current, body, new Date(), [
      previous,
    ]);

    const verify = publishedVerifier();

    expect(verify(previous, body, header)).toBe(true);
    expect(verify(current, body, header)).toBe(true);
    expect(verify(current, `${body} `, header)).toBe(false);
  });

  it("refuses a replay from outside the tolerance", () => {
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(
      secret,
      body,
      new Date(Date.now() - 10 * 60 * 1000),
    );

    expect(publishedVerifier()(secret, body, header)).toBe(false);
  });
});

/**
 * A receiver gets garbage too: scanners, a proxy that drops the header, a
 * v1 of the right length that is not hex. The samples used to throw there
 * (Node's timingSafeEqual on buffers of different lengths, Python's int() on
 * a malformed t), and whoever copied them answered 500 instead of 401.
 */
describe("the published Node sample on a malformed header", () => {
  const body = JSON.stringify({
    id: "evt-2",
    topic: "delivery.created",
    data: {},
  });

  it("returns false for a 64-character v1 that is not hex, instead of throwing", () => {
    const secret = newWebhookSecret();
    const { timestamp } = signWebhookPayload(secret, body);

    const verify = publishedVerifier();

    expect(() =>
      verify(secret, body, `t=${timestamp},v1=${"z".repeat(64)}`),
    ).not.toThrow();
    expect(verify(secret, body, `t=${timestamp},v1=${"z".repeat(64)}`)).toBe(
      false,
    );
    expect(verify(secret, body, `t=${timestamp},v1=ab${"g".repeat(62)}`)).toBe(
      false,
    );
  });

  it("returns false when the header is missing", () => {
    const verify = publishedVerifier() as (
      secret: string,
      rawBody: string,
      header: string | undefined,
    ) => boolean;

    expect(verify(newWebhookSecret(), body, undefined)).toBe(false);
    expect(verify(newWebhookSecret(), body, "lixo")).toBe(false);
  });

  it("still accepts the real signature next to a garbage one", () => {
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(secret, body);

    expect(
      publishedVerifier()(secret, body, `${header},v1=${"z".repeat(64)}`),
    ).toBe(true);
  });
});

/** A Python 3 on this machine, when there is one (CI images may lack it). */
function pythonCommand(): string | null {
  for (const command of ["python3", "python"]) {
    const probe = spawnSync(command, ["--version"], { encoding: "utf8" });

    if (
      probe.status === 0 &&
      /Python 3/.test(`${probe.stdout}${probe.stderr}`)
    ) {
      return command;
    }
  }

  return null;
}

const python = pythonCommand();

describe.runIf(python)("the published Python sample", () => {
  const body = JSON.stringify({
    id: "evt-3",
    topic: "proof.approved",
    data: {},
  });

  /** Runs the sample as pasted, over each header; "raise" when it threw. */
  function runPython(secret: string, headers: string[]): string[] {
    const script = [
      PYTHON_VERIFICATION_SAMPLE,
      "",
      "import json, sys",
      "cases = json.load(sys.stdin)",
      "out = []",
      "for header in cases['headers']:",
      "    try:",
      "        out.append(str(verify_trajetto(cases['secret'], cases['body'].encode('utf-8'), header)))",
      "    except Exception as error:",
      "        out.append('raise:' + type(error).__name__)",
      "print(json.dumps(out))",
    ].join("\n");

    const result = spawnSync(python as string, ["-c", script], {
      input: JSON.stringify({ secret, body, headers }),
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);

    return JSON.parse(result.stdout) as string[];
  }

  it("accepts a call this API signed and refuses a stripped prefix", () => {
    const secret = newWebhookSecret();
    const { header } = signWebhookPayload(secret, body);

    expect(runPython(secret, [header])).toEqual(["True"]);
    expect(runPython(secret.replace(/^whsec_/, ""), [header])).toEqual([
      "False",
    ]);
  });

  it("returns False for a malformed header instead of raising", () => {
    const secret = newWebhookSecret();
    const { timestamp, signature } = signWebhookPayload(secret, body);

    expect(
      runPython(secret, [
        `t=abc,v1=${signature}`,
        `t=,v1=${signature}`,
        "lixo",
        `t=${timestamp},lixo,v1=${"a".repeat(64)}`,
        // compare_digest refuses a str with non-ASCII characters (TypeError).
        `t=${timestamp},v1=ç${"a".repeat(63)}`,
        "",
      ]),
    ).toEqual(["False", "False", "False", "False", "False", "False"]);

    // A part without "=" next to the real signature does not hide it.
    expect(runPython(secret, [`t=${timestamp},lixo,v1=${signature}`])).toEqual([
      "True",
    ]);
  });
});
