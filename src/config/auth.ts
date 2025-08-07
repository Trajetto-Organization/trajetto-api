import { env } from "@/env";

export default {
  secret_token: env.JWT_SECRET,
  secret_refresh_token: env.JWT_SECRET_REFRESH_TOKEN,
  expires_in_token: "10h",
  expires_in_refresh_token: "1d",
  expires_in_refresh_token_days: 24 * 60 * 60 * 1000, // 1 day in milliseconds
};
