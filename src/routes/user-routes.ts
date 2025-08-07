import { FastifyInstance } from "fastify";
import { z } from "zod";

import { CreateUserController } from "@/modules/user/usecases/create-user/create-user-controller";
import { AuthenticateUserController } from "@/modules/user/usecases/authenticate-user/authenticate-user-controller";

import { ForgotPasswordVerificationController } from "@/modules/user/usecases/forgot-password-verification/forgot-password-verification-controller";
import { ResetUserPasswordController } from "@/modules/user/usecases/reset-user-password/reset-user-password-controller";

import { SendForgotPasswordMailController } from "@/modules/user/usecases/send-forgot-password-mail/send-forgot-password-mail-controller";
import { RefreshTokenController } from "@/modules/user/usecases/refresh-token/refresh-token-controller";

import { TwoFactorVerificationController } from "@/modules/user/usecases/two-factor-verification/two-factor-verification-controller";
import { GetUserController } from "@/modules/user/usecases/get-user/get-user-controller";

import { UpdateUserNameController } from "@/modules/user/usecases/update-user-name/update-user-name-controller";
import { UpdateTwoFactorAuthenticationController } from "@/modules/user/usecases/update-two-factor-authentication/update-two-factor-authentication-controller";

import { UpdateEmailNotificationsController } from "@/modules/user/usecases/update-email-notifications/update-email-notifications-controller";
import { UpdateActivityNotificationsController } from "@/modules/user/usecases/update-activity-notifications/update-activity-notifications-controller";

import { UpdateUserPasswordController } from "@/modules/user/usecases/update-user-password/update-user-password-controller";
import { ListUsersController } from "@/modules/user/usecases/list-users/list-users-controller";

import { UpdateUserController } from "@/modules/user/usecases/update-user/update-user-controller";
import { DeleteUserController } from "@/modules/user/usecases/delete-user/delete-user-controller";

import { ListUserBusinessController } from "@/modules/user/usecases/list-user-business/list-user-business-controller";
import { EmailVerificationController } from "@/modules/user/usecases/e-mail-verification/e-mail-verification-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { ResendTwoFactorCodeController } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-controller";
import { UserRevokeAccessController } from "@/modules/user/usecases/user-revoke-access/user-revoke-access-controller";

import { userResponses, userSchemas } from "./documentation/user-documentation";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

const createUserController = new CreateUserController();
const listUsersController = new ListUsersController();

const listUserBusinessController = new ListUserBusinessController();
const authenticateUserController = new AuthenticateUserController();

const forgotPasswordVerificationController =
  new ForgotPasswordVerificationController();
const resetUserPasswordController = new ResetUserPasswordController();

const sendForgotPasswordMailController = new SendForgotPasswordMailController();
const refreshTokenController = new RefreshTokenController();

const twoFactorVerificationController = new TwoFactorVerificationController();
const resendTwoFactorCodeController = new ResendTwoFactorCodeController();

const emailVerificationController = new EmailVerificationController();

const getUserController = new GetUserController();
const deleteUserController = new DeleteUserController();

const updateUserPasswordController = new UpdateUserPasswordController();
const updateUserController = new UpdateUserController();

const updateUserNameController = new UpdateUserNameController();
const updateTwoFactorAuthenticationController =
  new UpdateTwoFactorAuthenticationController();

const updateEmailNotificationsController = new UpdateEmailNotificationsController();
const updateActivityNotificationsController = new UpdateActivityNotificationsController();

const userRevokeAccessController = new UserRevokeAccessController();

async function userRoutes(app: FastifyInstance) {
  app.post(
    "/create-user",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 20 }),
      },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Create a new user",
        body: userSchemas.createUser,
        response: {
          201: userResponses.userCreated,
          400: z.union([
            userResponses.resourceNotFound,
            userResponses.profileNotFromSameCompany,
            userResponses.companyNotFound,
            userResponses.profileAccessNotFound,
          ]),
          409: userResponses.userAlreadyExists,
          500: userResponses.internalServerError,
        },
      },
    },
    createUserController.handle,
  );

  app.get(
    "/list-user",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "List users",
        querystring: userSchemas.listUsers,
        response: {
          200: userResponses.usersList,
          400: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    listUsersController.handle,
  );

  app.get(
    "/list-user-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "List business users",
        querystring: userSchemas.listUserBusiness,
        response: {
          200: userResponses.usersList,
          400: userResponses.listUserBusinessErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    listUserBusinessController.handle,
  );

  app.post(
    "/session",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 8 }),
      },
      schema: {
        tags: ["user"],
        description: "User session",
        body: userSchemas.authenticateUser,
        response: {
          200: z.union([
            userResponses.emailVerificationSent,
            userResponses.twoFactorVerificationSent,
            userResponses.userAuthenticated,
          ]),
          400: z.union([
            userResponses.invalidCredentials,
            userResponses.userWithoutProfile,
          ]),
          500: userResponses.internalServerError,
        },
      },
    },
    authenticateUserController.handle,
  );

  app.get(
    "/forgot-verification",
    {
      schema: {
        tags: ["user"],
        description: "Forgot password verification",
        querystring: userSchemas.forgotPasswordVerification,
        response: {
          200: userResponses.forgotPasswordVerificationSuccess,
          400: z.union([
            userResponses.resourceNotFound,
            userResponses.invalidToken,
            userResponses.expiredToken,
          ]),
          500: userResponses.internalServerError,
        },
      },
    },
    forgotPasswordVerificationController.handle,
  );

  app.post(
    "/reset/password",
    {
      schema: {
        tags: ["user"],
        description: "Reset user password",
        querystring: userSchemas.forgotPasswordVerification,
        body: userSchemas.forgotPassword,
        response: {
          200: userResponses.passwordResetSuccess,
          400: z.union([
            userResponses.invalidToken,
            userResponses.expiredToken,
            userResponses.resourceNotFound,
          ]),
          500: userResponses.internalServerError,
        },
      },
    },
    resetUserPasswordController.handle,
  );

  app.post(
    "/forgot/password",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 4 }),
      },
      schema: {
        tags: ["user"],
        description: "Forgot user password",
        body: userSchemas.sendForgotPassword,
        response: {
          200: userResponses.forgotPasswordEmailSent,
          400: userResponses.forgotPasswordEmailSent,
          500: userResponses.internalServerError,
        },
      },
    },
    sendForgotPasswordMailController.handle,
  );

  app.post(
    "/refresh-token",
    {
      schema: {
        tags: ["user"],
        description: "Refresh user token",
        body: userSchemas.refreshToken,
        response: {
          201: userResponses.tokenRefreshed,
          400: z.union([
            userResponses.invalidCredentials,
            userResponses.refreshTokenNotExists,
          ]),
          403: userResponses.userWithoutProfile,
          401: userResponses.invalidTokenSignature,
          500: userResponses.internalServerError,
        },
      },
    },
    refreshTokenController.handle,
  );

  app.post(
    "/two-factor-verification",
    {
      schema: {
        tags: ["user"],
        description: "Two factor user verification",
        body: userSchemas.twoFactorUser,
        response: {
          200: userResponses.twoFactorSuccess,
          403: userResponses.userWithoutProfile,
          400: z.union([
            userResponses.invalidCode,
            userResponses.expiredCode,
            userResponses.resourceNotFound,
            userResponses.invalidUserCode,
          ]),
          500: userResponses.internalServerError,
        },
      },
    },
    twoFactorVerificationController.handle,
  );

  app.post(
    "/email-verification",
    {
      schema: {
        tags: ["user"],
        description: "Verify user e-mail",
      },
    },
    emailVerificationController.handle,
  );

  app.post(
    "/resend-two-factor-code",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 1, timeWindow: 10000 }),
      },
      schema: {
        tags: ["user"],
        description: "Resend two factor code",
        body: userSchemas.resendTwoFactorCode,
        response: {
          200: userResponses.genericMessage,
          400: z.union([
            userResponses.resourceNotFound,
            userResponses.noActiveTwoFactor,
          ]),
          500: userResponses.internalServerError,
        },
      },
    },
    resendTwoFactorCodeController.handle,
  );

  app.get(
    "/me",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Get a user",
        response: {
          200: userResponses.userReturned,
          400: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    getUserController.handle,
  );

  app.delete(
    "/delete-user/:userId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Delete a user",
        params: userSchemas.updateDeleteUser,
        response: {
          200: userResponses.userDeleted,
          400: userResponses.resourceNotFound,
          403: userResponses.cannotDeleteSelf,
          500: userResponses.internalServerError,
        },
      },
    },
    deleteUserController.handle,
  );

  app.patch(
    "/update-user/:userId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "write")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Update a user",
        params: userSchemas.updateDeleteUser,
        body: userSchemas.updateUser,
        response: {
          200: userResponses.userUpdated,
          400: z.union([
            userResponses.resourceNotFound,
            userResponses.companyNotFound,
            userResponses.profileAccessNotFound,
          ]),
          403: z.union([
            userResponses.cannotUpdateSelf,
            userResponses.profileNotFromSameCompany,
          ]),
          409: userResponses.userAlreadyExists,
          500: userResponses.internalServerError,
        },
      },
    },
    updateUserController.handle,
  );

  app.patch(
    "/password",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Update a user password",
        body: userSchemas.updateUserPassword,
        response: {
          200: userResponses.passwordUpdated,
          400: z.union([
            userResponses.resourceNotFound,
            userResponses.incorrectCurrentPassword,
            userResponses.newPasswordSameAsOld,
          ]),
          500: userResponses.internalServerError,
        },
      },
    },
    updateUserPasswordController.handle,
  );

  app.patch(
    "/username",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Update a user name",
        body: userSchemas.updateUserName,
        response: {
          200: userResponses.usernameUpdated,
          400: z.union([
            userResponses.resourceNotFound,
            userResponses.newNameMustBeDifferent,
          ]),
          500: userResponses.internalServerError,
        },
      },
    },
    updateUserNameController.handle,
  );

  app.patch(
    "/twofactor",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Update a user two factor",
        response: {
          200: userResponses.twoFactorUpdated,
          400: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    updateTwoFactorAuthenticationController.handle,
  );

  app.patch(
    "/email-notifications",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Update user email notifications",
        response: {
          200: userResponses.genericMessage,
          400: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    updateEmailNotificationsController.handle,
  );

  app.patch(
    "/activity-notifications",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        description: "Update user activity notifications",
        response: {
          200: userResponses.genericMessage,
          400: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    updateActivityNotificationsController.handle,
  );

  app.patch(
    "/revoke-access/:userId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
    },
    userRevokeAccessController.handle,
  );
}

export { userRoutes };
