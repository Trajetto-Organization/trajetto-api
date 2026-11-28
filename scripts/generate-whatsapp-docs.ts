/**
 * Writes docs/whatsapp-modelos.md from the WhatsApp template registries:
 * `yarn docs:whatsapp`, after any change to a template in
 * src/shared/notifications/whatsapp-templates.ts or
 * src/shared/delivery/customer-whatsapp-templates.ts. The markdown itself is
 * built by scripts/whatsapp-templates-doc.ts, which the drift test reads too.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  WHATSAPP_TEMPLATES_DOC_PATH,
  formatWhatsAppTemplatesDoc,
  renderWhatsAppTemplatesDoc,
} from "./whatsapp-templates-doc";

async function main(): Promise<void> {
  const target = resolve(process.cwd(), WHATSAPP_TEMPLATES_DOC_PATH);
  const markdown = await formatWhatsAppTemplatesDoc(
    renderWhatsAppTemplatesDoc(),
  );

  writeFileSync(target, markdown);
  console.log(`${WHATSAPP_TEMPLATES_DOC_PATH}: ${markdown.length} caracteres`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
