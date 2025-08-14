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

const updateEmailNotificationsController =
  new UpdateEmailNotificationsController();
const updateActivityNotificationsController =
  new UpdateActivityNotificationsController();

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
        summary: "Create a new user",
        description:
          "Register a new user account with authentication credentials and profile access permissions",
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
        summary: "List users",
        description:
          "Retrieve a paginated list of system users with optional search and filtering capabilities",
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
        summary: "List business users",
        description:
          "Retrieve a paginated list of users filtered by specific business with search functionality",
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
        summary: "Authenticate user",
        description:
          "Authenticate user credentials and establish a new session with access tokens",
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
        summary: "Verify password reset token",
        description: "Verify the validity of a password reset token received via email before allowing password change",
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
        summary: "Reset user password",
        description: "Reset user password using a valid token received through the forgot password process",
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
        summary: "Request password reset",
        description: "Send a password reset email with verification token to the user's registered email address",
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
        summary: "Refresh authentication token",
        description: "Generate new access and refresh tokens using a valid refresh token to maintain user session",
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
        summary: "Verify two-factor authentication",
        description: "Complete user authentication by verifying the two-factor authentication code sent via email",
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
        summary: "Verify user email",
        description: "Complete user email verification process to activate account and enable email notifications",
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
        summary: "Resend two-factor code",
        description: "Resend the two-factor authentication code via email if the previous code expired or was not received",
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
        summary: "Get user profile",
        description:
          "Retrieve detailed profile information for the authenticated user",
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
        summary: "Delete a user",
        description: "Permanently remove a user account from the system and revoke all associated access permissions",
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
        summary: "Update a user",
        description: "Update existing user account information including profile details and access permissions",
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
        summary: "Update user password",
        description: "Change the authenticated user's password by providing current password and new password",
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
        summary: "Update user name",
        description: "Update the authenticated user's display name and profile information",
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
        summary: "Toggle two-factor authentication",
        description: "Enable or disable two-factor authentication for the authenticated user's account security",
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
        summary: "Update email notification settings",
        description: "Configure email notification preferences for the authenticated user's account",
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
        summary: "Update activity notification settings",
        description: "Configure activity notification preferences for system events and updates for the authenticated user",
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
      preHandler: [verifyUserRole(["MASTER", "BUSINESS_ADMIN"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Revoke user access",
        description: "Revoke or restore access for a specific user account",
        params: userSchemas.revokeUserAccess,
        response: {
          200: userResponses.userAccessRevoked,
          400: userResponses.resourceNotFound,
          403: userResponses.cannotRevokeOwnAccess,
          500: userResponses.internalServerError,
        },
      },
    },
    userRevokeAccessController.handle,
  );
}

export { userRoutes };
