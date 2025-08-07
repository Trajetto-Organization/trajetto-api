import { FastifyInstance } from "fastify";

import { CreateAccountPayableController } from "@/modules/account-payable/usecases/create-account-payable/create-account-payable-controller";
import { ListAccountPayableController } from "@/modules/account-payable/usecases/list-account-payable/list-account-payable-controller";

import { UpdateAccountPayableController } from "@/modules/account-payable/usecases/update-account-payable/update-account-payable-controller";
import { DeleteAccountPayableController } from "@/modules/account-payable/usecases/delete-account-payable/delete-account-payable-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { verifyPermission } from "@/modules/middlewares/verify-permission";

import {
  accountPayableSchemas,
  accountPayableResponses,
} from "./documentation/account-payable-documentation";

const createAccountPayableController = new CreateAccountPayableController();
const listAccountPayableController = new ListAccountPayableController();

const updateAccountPayableController = new UpdateAccountPayableController();
const deleteAccountPayableController = new DeleteAccountPayableController();

async function accountPayableRoutes(app: FastifyInstance) {
  app.post(
    "/create-account-payable/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        description: "Create a new account payable",
        params: accountPayableSchemas.businessIdParam,
        body: accountPayableSchemas.createAccountPayable,
        response: {
          201: accountPayableResponses.accountPayableCreated,
          400: accountPayableResponses.createAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    createAccountPayableController.handle,
  );

  app.get(
    "/list-account-payable",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        description: "List account payables",
        querystring: accountPayableSchemas.listAccountPayable,
        response: {
          200: accountPayableResponses.accountPayableList,
          400: accountPayableResponses.listAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    listAccountPayableController.handle,
  );

  app.patch(
    "/update-account-payable/:accountPayableId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        description: "Update account payable information",
        params: accountPayableSchemas.accountPayableBusinessParams,
        body: accountPayableSchemas.updateAccountPayable,
        response: {
          200: accountPayableResponses.accountPayableUpdated,
          400: accountPayableResponses.updateAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    updateAccountPayableController.handle,
  );

  app.delete(
    "/delete-account-payable/:accountPayableId/business/:businessId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("account_payable_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["account-payable"],
        description: "Delete an account payable",
        params: accountPayableSchemas.accountPayableBusinessParams,
        response: {
          200: accountPayableResponses.accountPayableDeleted,
          400: accountPayableResponses.deleteAccountPayableErrors,
          500: accountPayableResponses.internalServerError,
        },
      },
    },
    deleteAccountPayableController.handle,
  );
}

export { accountPayableRoutes };
