import { FastifyReply, FastifyRequest } from "fastify";

import {
  TEMPLATE_CONTENT_TYPE,
  TEMPLATE_FILENAME,
  buildTemplateWorkbook,
} from "@/shared/delivery/spreadsheet-template-file";

/**
 * Hands over the spreadsheet model.
 *
 * Thin on purpose: the document itself is built in `spreadsheet-template-file`
 * so the suite can generate it and feed it back through the importer. A model
 * our own parser refuses is the worst possible bug in an import feature, and
 * it is only catchable by round-tripping a real workbook.
 */
class DownloadTemplateController {
  async handle(_request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const file = await buildTemplateWorkbook();

    return reply
      .header("Content-Type", TEMPLATE_CONTENT_TYPE)
      .header(
        "Content-Disposition",
        `attachment; filename="${TEMPLATE_FILENAME}"`,
      )
      .send(file);
  }
}

export { DownloadTemplateController };
