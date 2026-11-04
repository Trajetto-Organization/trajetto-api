import { env } from "@/env";

export default {
  secret_token: env.JWT_SECRET,
  secret_refresh_token: env.JWT_SECRET_REFRESH_TOKEN,
  expires_in_token: "15m",

  /**
   * How long a session may go unused before its refresh token lapses, and
   * how long it may live at all, per client. In seconds.
   *
   * One day for everybody broke the driver's app, which is built to work
   * offline for a week: a phone 25 hours without signal came back to a
   * refused refresh and logged the driver out just as the queue tried to
   * send what it had kept. The app now idles for seven days. In exchange
   * its family has an absolute cap, counted from the login, so a copied
   * mobile token does not slide forever. The web keeps its day and no cap,
   * which is exactly what it had.
   *
   * Every rotation slides the idle window; the cap does not move.
   *
   * `driver_device` is the driver's phone (plan of 02/11/2026, D4; decision
   * D03): a session opened by the manager's QR code, or by CPF and password
   * with the phone's id. Under the mobile policy the driver would have to
   * read a new QR code every month, so it idles for 30 days and lives 180.
   * In exchange it is bound to that phone: the refresh token carries a hash
   * of the device id, and a refresh from any other device is refused (see
   * session-service). It is never chosen by a header — only the QR code and
   * the CPF login open it, and the signed claim keeps it across rotations.
   */
  refresh_policies: {
    web: { idleSeconds: 24 * 60 * 60, maxAgeSeconds: null },
    mobile: { idleSeconds: 7 * 24 * 60 * 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
    driver_device: {
      idleSeconds: 30 * 24 * 60 * 60,
      maxAgeSeconds: 180 * 24 * 60 * 60,
    },
  },
};
