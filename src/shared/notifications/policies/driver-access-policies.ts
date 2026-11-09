import { NotificationCategory } from "@prisma/client";

import type {
  DriverAccessPayload,
  NotificationPolicyEntry,
  PolicyDeps,
  RenderContext,
  RenderedInApp,
} from "../notification-types";

/**
 * A driver's login reached by a way the company should see (wave 2,
 * 06/11/2026): the manager's QR code consumed on a phone that login did not
 * trust before, or a password created right after a QR code, without the
 * current one. Either is how a QR code read out over the phone to somebody
 * posing as the driver would be used, so the company's admins hear it — all
 * but the manager who issued the QR, who already knows.
 *
 * In-app, and push where the admin has the app, by their preferences: an
 * ACCOUNT notice, not mandatory. No e-mail (the security notice lives in the
 * inbox) and no WhatsApp (no approved template). The activity is written by
 * the use case itself, for the driver's login.
 */

const USERS_PAGE_PATH = "/dashboard/user-registration";

async function adminsButIssuer(payload: DriverAccessPayload, deps: PolicyDeps) {
  const admins = await deps.userRepository.findBusinessAdminsByBusinessId(
    payload.businessId,
  );

  return admins.filter(
    (admin) =>
      admin.id !== payload.issuedById && admin.id !== payload.driverUserId,
  );
}

/** The users page, searched by the driver's name: the access actions are there. */
function usersPageLink(payload: DriverAccessPayload, ctx: RenderContext) {
  return `${ctx.baseUrl}${USERS_PAGE_PATH}?search=${encodeURIComponent(payload.driverName)}&page=1`;
}

function renderNewDeviceInApp(
  payload: DriverAccessPayload,
  ctx: RenderContext,
): RenderedInApp {
  return {
    type: "driver-access",
    title: "Aparelho novo do motorista",
    message:
      `${payload.driverName} entrou no app em um aparelho novo pelo QR Code de acesso. ` +
      "Se não foi combinado, desconecte o aparelho na tela de usuários.",
    link: usersPageLink(payload, ctx),
    entityId: payload.driverUserId,
  };
}

function renderPasswordCreatedInApp(
  payload: DriverAccessPayload,
  ctx: RenderContext,
): RenderedInApp {
  return {
    type: "driver-access",
    title: "Senha criada pelo motorista",
    message:
      `${payload.driverName} criou uma senha nova logo depois de entrar pelo QR Code de acesso, e as outras sessões dele foram encerradas. ` +
      "Se não foi combinado, redefina a senha e desconecte os aparelhos na tela de usuários.",
    link: usersPageLink(payload, ctx),
    entityId: payload.driverUserId,
  };
}

const driverAccessNewDevicePolicy: NotificationPolicyEntry<DriverAccessPayload> =
  {
    category: NotificationCategory.ACCOUNT,
    suppressEmail: true,
    resolveRecipients: adminsButIssuer,
    renderInApp: renderNewDeviceInApp,
  };

const driverAccessPasswordCreatedPolicy: NotificationPolicyEntry<DriverAccessPayload> =
  {
    category: NotificationCategory.ACCOUNT,
    suppressEmail: true,
    resolveRecipients: adminsButIssuer,
    renderInApp: renderPasswordCreatedInApp,
  };

export {
  driverAccessNewDevicePolicy,
  driverAccessPasswordCreatedPolicy,
  renderNewDeviceInApp,
  renderPasswordCreatedInApp,
};
