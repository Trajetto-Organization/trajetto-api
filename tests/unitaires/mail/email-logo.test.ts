import { describe, expect, it } from "vitest";

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { env } from "@/env";
import {
  EMAIL_LOGO_PATH,
  buildEmailLogoUrl,
  emailLogoUrl,
} from "@/shared/providers/mail-provider/email-logo";

/**
 * The logo in every e-mail, served by the API itself.
 *
 * It used to be an image on an external host, named by its own environment
 * variable and copied into a private field of a dozen use cases. Now the URL
 * is built in one place from the API's public address (API_HTTP_REQUEST), and
 * without that address the e-mail goes out without a logo, as an empty
 * variable did before.
 */
const SOURCE = resolve(__dirname, "../../../src");

function tsFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);

    if (statSync(path).isDirectory()) return tsFiles(path);

    return path.endsWith(".ts") ? [path] : [];
  });
}

describe("the e-mail logo URL", () => {
  it("is the API's own logo route, under its public address", () => {
    expect(EMAIL_LOGO_PATH).toBe("/assets/trajetto-logo.png");
    expect(buildEmailLogoUrl("https://api.exemplo.com.br")).toBe(
      "https://api.exemplo.com.br/assets/trajetto-logo.png",
    );
  });

  it("does not double the slash of an address that ends in one", () => {
    expect(buildEmailLogoUrl("https://api.exemplo.com.br/")).toBe(
      "https://api.exemplo.com.br/assets/trajetto-logo.png",
    );
  });

  it.each([undefined, "", "   "])(
    "is absent when the API address is not set (%j)",
    (address) => {
      expect(buildEmailLogoUrl(address)).toBeUndefined();
    },
  );
});

describe("the URL the e-mails get", () => {
  it("is built from API_HTTP_REQUEST", () => {
    expect(emailLogoUrl()).toBe(buildEmailLogoUrl(env.API_HTTP_REQUEST));
  });
});

describe("every e-mail call site", () => {
  const sites = tsFiles(SOURCE).flatMap((file) =>
    readFileSync(file, "utf8")
      .split("\n")
      .map((line, index) => ({ file, line: line.trim(), number: index + 1 }))
      .filter(({ line }) => /^logo:/.test(line)),
  );

  it("exists — the scan found the mail variables", () => {
    expect(sites.length).toBeGreaterThan(10);
  });

  it("takes the logo from the one helper, not a field or variable of its own", () => {
    const elsewhere = sites
      .filter(({ line }) => line !== "logo: emailLogoUrl(),")
      .map(
        ({ file, line, number }) =>
          `${relative(SOURCE, file)}:${number} ${line}`,
      );

    expect(elsewhere).toEqual([]);
  });
});
