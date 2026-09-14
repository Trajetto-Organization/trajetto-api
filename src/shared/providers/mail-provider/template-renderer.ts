import fs from "node:fs";
import handlebars from "handlebars";

import { toTemplateError } from "./errors/mail-delivery-error";

/**
 * Compiled templates are cached by path: the pipeline now sends in-process,
 * so the same handful of .hbs files would otherwise be read and recompiled
 * on every single delivery.
 */
type CompiledTemplate = ReturnType<typeof handlebars.compile>;

const templateCache = new Map<string, CompiledTemplate>();

function renderMailTemplate(path: string, variables: unknown): string {
  try {
    let template = templateCache.get(path);

    if (!template) {
      const templateFileContent = fs.readFileSync(path).toString("utf-8");

      template = handlebars.compile(templateFileContent);
      templateCache.set(path, template);
    }

    return template(variables);
  } catch (error) {
    throw toTemplateError(error, path);
  }
}

export { renderMailTemplate };
