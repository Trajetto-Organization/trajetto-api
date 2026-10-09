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
   */
  refresh_policies: {
    web: { idleSeconds: 24 * 60 * 60, maxAgeSeconds: null },
    mobile: { idleSeconds: 7 * 24 * 60 * 60, maxAgeSeconds: 30 * 24 * 60 * 60 },
  },
};
