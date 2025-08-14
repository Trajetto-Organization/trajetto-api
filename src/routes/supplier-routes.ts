import { FastifyInstance } from "fastify";

import { CreateSupplierController } from "@/modules/supplier/usecases/create-supplier/create-supplier-controller";
import { DeleteSupplierController } from "@/modules/supplier/usecases/delete-supplier/delete-supplier-controller";

import { ListSupplierController } from "@/modules/supplier/usecases/list-supplier/list-supplier-controller";
import { ListSupplierBusinessController } from "@/modules/supplier/usecases/list-supplier-business/list-supplier-business-controller";

import { UpdateSupplierController } from "@/modules/supplier/usecases/update-supplier/update-supplier-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  supplierResponses,
  supplierSchemas,
} from "./documentation/supplier-documentation";

const createSupplierController = new CreateSupplierController();
const deleteSupplierController = new DeleteSupplierController();

const listSupplierController = new ListSupplierController();
const listSupplierBusinessController = new ListSupplierBusinessController();

const updateSupplierController = new UpdateSupplierController();

async function supplierRoutes(app: FastifyInstance) {
  app.post(
    "/create-supplier/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("supplier_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Create a new supplier",
        description: "Register a new supplier company with contact information and business relationship details",
        params: supplierSchemas.updateDeleteBusiness,
        body: supplierSchemas.createSupplier,
        response: {
          201: supplierResponses.supplierCreated,
          400: supplierResponses.createSupplierErrors,
          500: supplierResponses.internalServerError,
        },
      },
    },
    createSupplierController.handle,
  );

  app.get(
    "/list-supplier",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("supplier_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "List suppliers",
        description: "Retrieve a paginated list of supplier companies with optional search and filtering capabilities",
        querystring: supplierSchemas.listSupplier,
        response: {
          200: supplierResponses.supplierList,
          400: supplierResponses.listSupplierErrors,
          500: supplierResponses.internalServerError,
        },
      },
    },
    listSupplierController.handle,
  );

  app.get(
    "/list-supplier-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("supplier_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "List suppliers by business",
        description: "Retrieve a paginated list of suppliers filtered by specific business with search functionality",
        querystring: supplierSchemas.listSupplierBusiness,
        response: {
          200: supplierResponses.supplierBusinessList,
          400: supplierResponses.listSupplierBusinessErrors,
          500: supplierResponses.internalServerError,
        },
      },
    },
    listSupplierBusinessController.handle,
  );

  app.patch(
    "/update-supplier/:supplierId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("supplier_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Update a supplier",
        description: "Update existing supplier information including contact details and business relationship data",
        params: supplierSchemas.supplierParams,
        body: supplierSchemas.updateSupplier,
        response: {
          200: supplierResponses.supplierUpdated,
          400: supplierResponses.updateSupplierErrors,
          404: supplierResponses.supplierNotFound,
          500: supplierResponses.internalServerError,
        },
      },
    },
    updateSupplierController.handle,
  );

  app.delete(
    "/delete-supplier/:supplierId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("supplier_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["supplier"],
        summary: "Delete a supplier",
        description: "Permanently remove a supplier company from the system and associated business relationships",
        params: supplierSchemas.supplierParams,
        response: {
          200: supplierResponses.supplierDeleted,
          400: supplierResponses.deleteSupplierErrors,
          404: supplierResponses.supplierNotFound,
          500: supplierResponses.internalServerError,
        },
      },
    },
    deleteSupplierController.handle,
  );
}

export { supplierRoutes };
