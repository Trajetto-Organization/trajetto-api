import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";

const dotenvConfig = dotenv.config();
dotenvExpand.expand(dotenvConfig);

import { envSchema } from "@/schemas/env-schema";

const _env = envSchema.safeParse(process.env);

if (_env.success === false) {
  console.error("Invalid enviroment variables", _env.error.format());
  throw new Error("Invalid enviroment variables");
}

export const env = _env.data;
