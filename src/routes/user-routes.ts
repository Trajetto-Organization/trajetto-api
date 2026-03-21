import { FastifyInstance } from "fastify";

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

import { EmailVerificationController } from "@/modules/user/usecases/e-mail-verification/e-mail-verification-controller";

import { ensureAuthenticated } from "@/modules/middlewares/ensure-authenticated";
import { getRateLimiterConfig } from "@/modules/middlewares/rate-limiter";

import { verifyPermission } from "@/modules/middlewares/verify-permission";

import { ResendTwoFactorCodeController } from "@/modules/user/usecases/resend-two-factor-code/resend-two-factor-code-controller";
import { UserRevokeAccessController } from "@/modules/user/usecases/user-revoke-access/user-revoke-access-controller";

import { UploadAvatarController } from "@/modules/user/usecases/upload-avatar/upload-avatar-controller";
import { DeleteAvatarController } from "@/modules/user/usecases/delete-avatar/delete-avatar-controller";

import { CreateMasterUserController } from "@/modules/user/usecases/create-master-user/create-master-user-controller";
import { ListMasterUsersController } from "@/modules/user/usecases/list-master-users/list-master-users-controller";

import { UpdateMasterUserController } from "@/modules/user/usecases/update-master-user/update-master-user-controller";
import { DeleteMasterUserController } from "@/modules/user/usecases/delete-master-user/delete-master-user-controller";

import { SearchUserCursorController } from "@/modules/user/usecases/search-user-cursor/search-user-cursor-controller";

import { userResponses, userSchemas } from "./documentation/user-documentation";
import { verifyUserRole } from "@/modules/middlewares/verify-user-role";

const createUserController = new CreateUserController();
const listUsersController = new ListUsersController();

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

const uploadAvatarController = new UploadAvatarController();
const deleteAvatarController = new DeleteAvatarController();

const createMasterUserController = new CreateMasterUserController();
const listMasterUsersController = new ListMasterUsersController();

const updateMasterUserController = new UpdateMasterUserController();
const deleteMasterUserController = new DeleteMasterUserController();

const searchUserCursorController = new SearchUserCursorController();

async function userRoutes(app: FastifyInstance) {
  app.post(
    "/create-user",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
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
          400: userResponses.createUserErrors,
          403: userResponses.createUserForbiddenErrors,
          409: userResponses.createUserConflictErrors,
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
          400: userResponses.listUsersErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    listUsersController.handle,
  );

  app.get(
    "/search-user-business",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyPermission("user_registration_manage", "read")],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Search users by business (cursor-based)",
        description:
          "Retrieve users as NDJSON stream with cursor-based pagination. " +
          "First line contains meta object: {meta: {nextCursor, hasMore}}. " +
          "Subsequent lines are individual user objects. " +
          "Use nextCursor value as cursor parameter for the next page.",
        querystring: userSchemas.searchUserCursor,
        response: {
          200: userResponses.searchUserStreamDescription,
          400: userResponses.listUserBusinessErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    searchUserCursorController.handle,
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
          200: userResponses.authenticateUserSuccess,
          400: userResponses.authenticateUserErrors,
          403: userResponses.authenticateUserForbiddenErrors,
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
        description:
          "Verify the validity of a password reset token received via email before allowing password change",
        querystring: userSchemas.forgotPasswordVerification,
        response: {
          200: userResponses.forgotPasswordVerificationSuccess,
          400: userResponses.forgotVerificationErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    forgotPasswordVerificationController.handle,
  );

  app.post(
    "/reset/password",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 4 }),
      },
      schema: {
        tags: ["user"],
        summary: "Reset user password",
        description:
          "Reset user password using a valid token received through the forgot password process",
        querystring: userSchemas.forgotPasswordVerification,
        body: userSchemas.forgotPassword,
        response: {
          200: userResponses.passwordResetSuccess,
          400: userResponses.resetPasswordErrors,
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
        description:
          "Send a password reset email with verification token to the user's registered email address",
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
        description:
          "Generate new access and refresh tokens using a valid refresh token to maintain user session",
        body: userSchemas.refreshToken,
        response: {
          201: userResponses.tokenRefreshed,
          400: userResponses.refreshTokenErrors,
          401: userResponses.refreshTokenUnauthorizedErrors,
          403: userResponses.refreshTokenForbiddenErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    refreshTokenController.handle,
  );

  app.post(
    "/two-factor-verification",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 4 }),
      },
      schema: {
        tags: ["user"],
        summary: "Verify two-factor authentication",
        description:
          "Complete user authentication by verifying the two-factor authentication code sent via email",
        body: userSchemas.twoFactorUser,
        response: {
          200: userResponses.twoFactorSuccess,
          400: userResponses.twoFactorVerificationErrors,
          403: userResponses.twoFactorVerificationForbiddenErrors,
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
        description:
          "Complete user email verification process to activate account and enable email notifications",
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
        description:
          "Resend the two-factor authentication code via email if the previous code expired or was not received",
        body: userSchemas.resendTwoFactorCode,
        response: {
          200: userResponses.genericMessage,
          400: userResponses.resendTwoFactorCodeErrors,
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
        description:
          "Permanently remove a user account from the system and revoke all associated access permissions",
        params: userSchemas.updateDeleteUser,
        response: {
          200: userResponses.userDeleted,
          400: userResponses.deleteUserErrors,
          403: userResponses.deleteUserForbiddenErrors,
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
        description:
          "Update existing user account information including profile details and access permissions",
        params: userSchemas.updateDeleteUser,
        body: userSchemas.updateUser,
        response: {
          200: userResponses.userUpdated,
          400: userResponses.updateUserErrors,
          403: userResponses.updateUserForbiddenErrors,
          409: userResponses.updateUserConflictErrors,
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
        description:
          "Change the authenticated user's password by providing current password and new password",
        body: userSchemas.updateUserPassword,
        response: {
          200: userResponses.passwordUpdated,
          400: userResponses.updatePasswordErrors,
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
        description:
          "Update the authenticated user's display name and profile information",
        body: userSchemas.updateUserName,
        response: {
          200: userResponses.usernameUpdated,
          400: userResponses.updateUsernameErrors,
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
        description:
          "Enable or disable two-factor authentication for the authenticated user's account security",
        response: {
          200: userResponses.twoFactorUpdated,
          400: userResponses.twoFactorUpdateErrors,
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
        description:
          "Configure email notification preferences for the authenticated user's account",
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
        description:
          "Configure activity notification preferences for system events and updates for the authenticated user",
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
          400: userResponses.revokeUserAccessErrors,
          403: userResponses.revokeUserAccessForbiddenErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    userRevokeAccessController.handle,
  );

  app.patch(
    "/avatar",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Upload or update user avatar",
        description:
          "Upload a new avatar image or replace the existing one for the authenticated user",
        response: {
          200: userResponses.genericMessage,
          400: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    uploadAvatarController.handle,
  );

  app.delete(
    "/avatar",
    {
      onRequest: [ensureAuthenticated],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Delete user avatar",
        description:
          "Remove the avatar image for the authenticated user and reset to default",
        response: {
          200: userResponses.genericMessage,
          400: userResponses.resourceNotFound,
          500: userResponses.internalServerError,
        },
      },
    },
    deleteAvatarController.handle,
  );

  // Master User Routes
  app.post(
    "/create-master-user",
    {
      config: {
        rateLimit: getRateLimiterConfig({ max: 10 }),
      },
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Create a new master user",
        description:
          "Register a new master user account with full system access privileges. Only existing master users can perform this action.",
        body: userSchemas.createMasterUser,
        response: {
          201: userResponses.masterUserCreated,
          400: userResponses.createMasterUserErrors,
          409: userResponses.createMasterUserConflictErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    createMasterUserController.handle,
  );

  app.get(
    "/list-master-users",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "List master users",
        description:
          "Retrieve a paginated list of all master users in the system with optional search functionality",
        querystring: userSchemas.listUsers,
        response: {
          200: userResponses.masterUsersList,
          500: userResponses.internalServerError,
        },
      },
    },
    listMasterUsersController.handle,
  );

  app.patch(
    "/update-master-user/:masterUserId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Update a master user",
        description:
          "Update an existing master user's name, email, or password. Only master users can perform this action.",
        params: userSchemas.updateMasterUserParams,
        body: userSchemas.updateMasterUser,
        response: {
          200: userResponses.masterUserUpdated,
          400: userResponses.updateMasterUserErrors,
          403: userResponses.updateMasterUserForbiddenErrors,
          409: userResponses.updateMasterUserConflictErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    updateMasterUserController.handle,
  );

  app.delete(
    "/delete-master-user/:masterUserId",
    {
      onRequest: [ensureAuthenticated],
      preHandler: [verifyUserRole(["MASTER"])],
      schema: {
        security: [{ bearerAuth: [] }],
        tags: ["user"],
        summary: "Delete a master user",
        description:
          "Permanently remove a master user account. Cannot delete yourself or the last remaining master user in the system.",
        params: userSchemas.updateMasterUserParams,
        response: {
          200: userResponses.masterUserDeleted,
          400: userResponses.deleteMasterUserErrors,
          403: userResponses.deleteMasterUserForbiddenErrors,
          500: userResponses.internalServerError,
        },
      },
    },
    deleteMasterUserController.handle,
  );
}

export { userRoutes };
