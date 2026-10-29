import { describe, expect, it } from "vitest";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Decision 4.9: a password never travels by e-mail.
 *
 * Creating a user, creating a master, and a master editing someone's
 * password all mailed the password in clear text (SEC-MAIL-1): readable by
 * anyone with the mailbox, the provider's logs or a forwarded message. Now
 * the person receives a single-use link and picks the password themselves.
 *
 * Read from the source and from the templates, so a new call site or a new
 * template that brings `{{password}}` back fails here.
 */
const SOURCE = resolve(__dirname, "../../../src");

function files(directory: string, extension: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) {
      found.push(...files(path, extension));
      continue;
    }

    if (path.endsWith(extension)) found.push(path);
  }

  return found;
}

/** The `{ ... }` starting at `start`, brace-balanced. */
function objectAt(source: string, start: number): string {
  let depth = 0;

  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }

  return source.slice(start);
}

/** Every variables object handed to a transactional e-mail. */
function mailVariables(): Array<{ file: string; body: string }> {
  const calls: Array<{ file: string; body: string }> = [];

  for (const file of files(SOURCE, ".ts")) {
    const source = readFileSync(file, "utf8");
    let at = source.indexOf("sendTransactionalMail({");

    while (at !== -1) {
      const call = objectAt(source, source.indexOf("{", at));
      const variablesAt = call.indexOf("additionalVariablesProperties");

      if (variablesAt !== -1) {
        calls.push({
          file: relative(SOURCE, file),
          body: objectAt(call, call.indexOf("{", variablesAt)),
        });
      }

      at = source.indexOf("sendTransactionalMail({", at + 1);
    }
  }

  return calls;
}

describe("no e-mail carries a password", () => {
  const calls = mailVariables();

  it("found the e-mails it checks", () => {
    // Without this the rules below pass over an empty list.
    expect(calls.length).toBeGreaterThanOrEqual(10);
  });

  it.each(calls.map((call) => [call.file, call] as const))(
    "%s passes no password variable",
    (_file, call) => {
      // A key named like a password, written out or shorthand; a URL path
      // such as /forgot/password is not a variable.
      expect(call.body).not.toMatch(
        /(?:^|[{,\s])(?:password|newPassword|rawPassword|finalPassword|senha)\s*(?::|,|\})/im,
      );
    },
  );

  it("no template of the product places a password", () => {
    const templates = files(join(SOURCE, "modules"), ".hbs");

    expect(templates.length).toBeGreaterThan(10);

    for (const template of templates) {
      const html = readFileSync(template, "utf8");

      expect(html, relative(SOURCE, template)).not.toMatch(
        /\{\{\s*(password|newPassword|senha)\s*\}\}/i,
      );
    }
  });
});
