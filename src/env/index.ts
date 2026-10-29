import * as dotenv from "dotenv";
import * as dotenvExpand from "dotenv-expand";

const dotenvConfig = dotenv.config();
dotenvExpand.expand(dotenvConfig);

import { envSchema } from "@/schemas/env-schema";
import { definedEnv } from "@/schemas/env-schema/defined-env";

// The compose hands an unset optional variable over as "", which would skip
// its default; see definedEnv.
const _env = envSchema.safeParse(definedEnv(process.env));

if (_env.success === false) {
  console.error("Invalid enviroment variables", _env.error.format());
  throw new Error("Invalid enviroment variables");
}

export const env = _env.data;
