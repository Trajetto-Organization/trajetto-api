import { FastifyInstance } from "fastify";

import { CreateFineController } from "@/modules/fine/usecases/create-fine/create-fine-controller";
import { ListFineController } from "@/modules/fine/usecases/list-fine/list-fine-controller";

import { ExportFineExcelController } from "@/modules/fine/usecases/export-fine-excel/export-fine-excel-controller";

import { UpdateFineController } from "@/modules/fine/usecases/update-fine/update-fine-controller";
import { DeleteFineController } from "@/modules/fine/usecases/delete-fine/delete-fine-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { listPagesSchema } from "@/schemas/list-pages-schema";

const createFineController = new CreateFineController();
const listFineController = new ListFineController();

const exportFineExcelController = new ExportFineExcelController();

const updateFineController = new UpdateFineController();
const deleteFineController = new DeleteFineController();

async function fineRoutes(app: FastifyInstance) {
  app.post(
    "/create-fine/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        description: "Register a new fine",
      },
    },
    createFineController.handle,
  );

  app.get(
    "/list-fine",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        description: "List fines with filters",
        querystring: listPagesSchema,
      },
    },
    listFineController.handle,
  );

  app.get(
    "/export-fine-excel",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        description: "Export fines report to Excel",
      },
    },
    exportFineExcelController.handle,
  );

  app.patch(
    "/update-fine/:fineId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        description: "Update information about a fine",
      },
    },
    updateFineController.handle,
  );

  app.delete(
    "/delete-fine/:fineId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("fine_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["fine"],
        description: "Delete a fine",
      },
    },
    deleteFineController.handle,
  );
}

export { fineRoutes };
