import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  WHATSAPP_TEMPLATES_DOC_PATH,
  formatWhatsAppTemplatesDoc,
  renderWhatsAppTemplatesDoc,
} from "../../../scripts/whatsapp-templates-doc";

/**
 * docs/whatsapp-modelos.md is the copy the owner pastes into Meta (plan of
 * 02/11/2026, B7): each body, limit, default and sample exactly as the code
 * sends and measures them. It is generated from the two registries by
 * `yarn docs:whatsapp`; a template changed in the code without regenerating
 * it fails here, before a body that is not the code's reaches Meta.
 */
describe("docs/whatsapp-modelos.md", () => {
  it("is what the template registries generate", async () => {
    const onDisk = readFileSync(
      resolve(process.cwd(), WHATSAPP_TEMPLATES_DOC_PATH),
      "utf8",
    ).replace(/\r\n/g, "\n");

    expect(await formatWhatsAppTemplatesDoc(renderWhatsAppTemplatesDoc())).toBe(
      onDisk,
    );
  });

  it("names the command that regenerates it", () => {
    expect(renderWhatsAppTemplatesDoc()).toContain("`yarn docs:whatsapp`");
  });
});
