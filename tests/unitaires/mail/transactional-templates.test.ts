import { describe, expect, it } from "vitest";

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { renderMailTemplate } from "@/shared/providers/mail-provider/template-renderer";

/**
 * Every transactional e-mail the product sends, checked without sending one.
 *
 * These are the messages that carry credentials, password resets, two-factor
 * codes and deletion confirmations — the ones a person is waiting for, and the
 * ones nobody notices are broken until somebody cannot get into their account.
 * There are eighteen call sites across fourteen templates and, before this,
 * not one test touched any of them.
 *
 * Three things can break silently, and all three are invisible in review:
 *
 *   1. the template FILE. `templateName` and `moduleName` are two strings that
 *      get joined into a path at runtime. Rename a file, move a module, mistype
 *      a name, and the failure happens in production, on the one e-mail that
 *      mattered;
 *   2. a VARIABLE the template needs and the call site does not pass. Handlebars
 *      renders a missing variable as empty — so a two-factor e-mail arrives with
 *      a blank where the code should be, which is worse than not arriving;
 *   3. a variable that is passed and NOT PLACED. A template that spells it
 *      `{{codigo}}`, or leaves it inside an HTML comment, passes every static
 *      check and still sends a blank.
 *
 * So the file is read, the variables are cross-checked, and then the thing is
 * actually RENDERED and the values are looked for in the output.
 */
const SOURCE = resolve(__dirname, "../../../src");

/** Always injected by `sendTransactionalMail`, so no call site passes them. */
const DEFAULTS = new Set(["name", "year"]);

/** Handlebars' own words, which are not variables. */
const HELPERS = new Set([
  "if",
  "unless",
  "each",
  "with",
  "else",
  "this",
  "log",
  "lookup",
]);

interface MailCall {
  file: string;
  module: string;
  template: string;
  subject: string | null;
  provided: Set<string>;
}

function tsFiles(directory: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      found.push(...tsFiles(path));
      continue;
    }

    if (path.endsWith(".ts")) found.push(path);
  }

  return found;
}

/** The `{ ... }` starting at `start`, brace-balanced. */
function objectAt(source: string, start: number): string {
  let depth = 0;

  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;

      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  return "";
}

/**
 * The keys of an object literal, including shorthand.
 *
 * `{ code }` and `{ code: value }` are the same thing to the template and were
 * not to the first version of this scan, which reported five false failures
 * about variables that were right there.
 */
function keysOf(objectSource: string): Set<string> {
  const inner = objectSource.slice(1, -1);

  const named = [...inner.matchAll(/(?:^|[,{]|\n)\s*([A-Za-z_]\w*)\s*:/g)].map(
    (match) => match[1],
  );

  const shorthand = [
    ...inner.matchAll(/(?:^|[,{]|\n)\s*([A-Za-z_]\w*)\s*(?=[,}\n])/g),
  ].map((match) => match[1]);

  return new Set([...named, ...shorthand]);
}

const CALLS: MailCall[] = tsFiles(SOURCE).flatMap((path) => {
  const source = readFileSync(path, "utf8");

  return [...source.matchAll(/sendTransactionalMail\(\{/g)].flatMap((match) => {
    const block = objectAt(source, match.index! + match[0].length - 1);

    const template = /templateName:\s*"([^"]+)"/.exec(block);
    const module = /moduleName:\s*"([^"]+)"/.exec(block);

    // The service's own definition, which passes the values through.
    if (!template || !module) return [];

    const extra = /additionalVariablesProperties:\s*\{/.exec(block);

    const provided = new Set(DEFAULTS);

    if (extra) {
      for (const key of keysOf(
        objectAt(block, extra.index! + extra[0].length - 1),
      )) {
        provided.add(key);
      }
    }

    return [
      {
        file: relative(SOURCE, path).split("\\").join("/"),
        module: module[1],
        template: template[1],
        /*
          A literal, a template literal, or an expression. Only the ABSENCE of
          a subject, or an empty literal, is a defect — three of these build
          the line from the company's name and the first version of this scan
          called all three "assunto vazio".
        */
        subject:
          /subject:\s*"([^"]*)"/.exec(block)?.[1] ??
          /subject:\s*`([^`]*)`/.exec(block)?.[1] ??
          (/subject:\s*\S/.test(block) ? "<expressão>" : null),
        provided,
      },
    ];
  });
});

function pathOf(call: MailCall): string {
  return join(SOURCE, "modules", call.module, "views", call.template);
}

/**
 * Every `{{ variable }}` a template actually references, including the ones
 * that only ever appear as a block helper's ARGUMENT.
 *
 * `{{#if hasFieldChanges}}` names a variable as surely as `{{name}}` does, and
 * the first version of this scan did not see it — so `hasFieldChanges` was
 * never given a value, the whole block it guards rendered as nothing, and the
 * test reported four variables "not written to the output" about a template
 * that was perfectly correct. A scan that under-reads the template accuses it.
 */
function variablesOf(html: string): Set<string> {
  const found = new Set<string>();

  const add = (raw: string) => {
    const [root] = raw.split(".");

    if (!HELPERS.has(root)) found.add(root);
  };

  for (const match of html.matchAll(/\{\{\{?\s*[#/^]?\s*([A-Za-z_][\w.]*)/g)) {
    add(match[1]);
  }

  // `{{#if x}}`, `{{#unless x}}`, `{{#each x}}`, `{{#with x}}`
  for (const match of html.matchAll(
    /\{\{#\s*(?:if|unless|each|with)\s+([A-Za-z_][\w.]*)/g,
  )) {
    add(match[1]);
  }

  return found;
}

/**
 * What each of these e-mails is FOR, named.
 *
 * Every other check in this file reads the template and then asks the template
 * about itself, which cannot notice the one failure that matters most: a
 * template that DROPPED the thing it exists to deliver. Deleting `{{url}}`
 * from the verification e-mail leaves a beautifully rendered page with a
 * warm greeting and no way to verify anything, and every assertion above goes
 * green, because the variable is no longer needed by a template that no longer
 * uses it.
 *
 * So the point of each message is written down here rather than derived. It is
 * a short list on purpose: only the messages whose whole purpose is to carry
 * one value.
 */
const MUST_CARRY: Record<string, string> = {
  "two-factor-verification-code.hbs": "token",
  "email-verification.hbs": "url",
  "forgot-password.hbs": "url",
  "branch-deletion-code.hbs": "code",
  "business-deletion-code.hbs": "code",
  // The link to set the password, never the password (decision 4.9).
  "user-created-successfully.hbs": "url",
  "password-reset-by-admin.hbs": "url",
};

describe("and the e-mail still carries the thing it exists for", () => {
  it.each(Object.entries(MUST_CARRY))("%s", (template, variable) => {
    const call = CALLS.find((candidate) => candidate.template === template);

    expect(call, `nenhum call site usa ${template}`).toBeDefined();

    const html = readFileSync(pathOf(call!), "utf8");

    expect(
      variablesOf(html).has(variable),
      `${template} não usa mais {{${variable}}} — o e-mail chega sem o que ele serve para entregar`,
    ).toBe(true);

    // And the call site still passes it, which is the other half of the same
    // sentence.
    expect(
      call!.provided.has(variable),
      `${call!.file} parou de passar ${variable} para ${template}`,
    ).toBe(true);
  });
});

describe("the scan itself", () => {
  it("found the e-mails", () => {
    /**
     * Without this every assertion below passes over an empty list, which is
     * how a rule stops being a rule: somebody renames the helper, the scan
     * matches nothing, and the suite goes green on zero e-mails.
     */
    expect(CALLS.length).toBeGreaterThanOrEqual(15);

    const templates = new Set(CALLS.map((call) => call.template));

    expect(templates.size).toBeGreaterThanOrEqual(10);
  });
});

describe("every e-mail has a template to render", () => {
  it.each(CALLS.map((call) => [`${call.file} → ${call.template}`, call] as const))(
    "%s",
    (_name, call) => {
      expect(
        existsSync(pathOf(call)),
        `arquivo não encontrado: src/modules/${call.module}/views/${call.template}`,
      ).toBe(true);
    },
  );
});

describe("and a subject a person can read", () => {
  it.each(CALLS.map((call) => [`${call.file} → ${call.template}`, call] as const))(
    "%s",
    (_name, call) => {
      // Not a style rule: a blank subject is what a spam filter reads first.
      expect(call.subject, `sem assunto em ${call.file}`).not.toBeNull();
      expect(call.subject, `assunto vazio em ${call.file}`).not.toBe("");
    },
  );
});

describe("and every variable it needs", () => {
  it.each(CALLS.map((call) => [`${call.file} → ${call.template}`, call] as const))(
    "%s",
    (_name, call) => {
      const needed = variablesOf(readFileSync(pathOf(call), "utf8"));

      const missing = [...needed].filter((variable) => !call.provided.has(variable));

      /*
        Handlebars renders a missing variable as an empty string, so this is
        not a crash waiting to happen — it is a two-factor e-mail arriving with
        nothing where the code should be.
      */
      expect(
        missing,
        `${call.template} usa ${missing.join(", ")} e ${call.file} não passa`,
      ).toEqual([]);
    },
  );
});

describe("and the template really places what it is given", () => {
  const TEMPLATES = [
    ...new Map(CALLS.map((call) => [call.template, call])).values(),
  ];

  it.each(TEMPLATES.map((call) => [call.template, call] as const))(
    "%s",
    (_name, call) => {
      const html = readFileSync(pathOf(call), "utf8");
      const needed = [...variablesOf(html)];

      /**
       * A distinctive value per variable, so the assertion cannot pass on a
       * coincidence — `2026` appears in the footer of every one of these, and
       * a check for "the year is in the output" would be satisfied by the
       * copyright line whatever the template did with the variable.
       */
      const variables = Object.fromEntries(
        needed.map((variable) => [variable, `VALOR-${variable.toUpperCase()}`]),
      );

      const rendered = renderMailTemplate(pathOf(call), variables);

      expect(rendered.length, "o template renderizou vazio").toBeGreaterThan(50);

      /*
        Conditionals and loops are references too, and a `{{#if logo}}` block
        legitimately hides its contents. Only the plain ones are required to
        appear.
      */
      const plain = needed.filter(
        (variable) =>
          new RegExp(`\\{\\{\\{?\\s*${variable}[\\s}]`).test(html) &&
          !new RegExp(`\\{\\{[#^]\\s*${variable}`).test(html),
      );

      const swallowed = plain.filter(
        (variable) => !rendered.includes(`VALOR-${variable.toUpperCase()}`),
      );

      expect(
        swallowed,
        `${call.template} declara ${swallowed.join(", ")} e não escreve na saída`,
      ).toEqual([]);
    },
  );

  it("and leaves no unresolved handlebars behind", () => {
    for (const call of TEMPLATES) {
      const html = readFileSync(pathOf(call), "utf8");

      const variables = Object.fromEntries(
        [...variablesOf(html)].map((variable) => [variable, "x"]),
      );

      const rendered = renderMailTemplate(pathOf(call), variables);

      expect(
        rendered.includes("{{"),
        `${call.template} saiu com handlebars por resolver`,
      ).toBe(false);

      // The other half of the same idea: a value that arrived as `undefined`
      // prints the word, and it prints it to a customer.
      expect(
        /\bundefined\b|\[object Object\]/.test(rendered),
        `${call.template} escreveu um valor cru na saída`,
      ).toBe(false);
    }
  });
});
