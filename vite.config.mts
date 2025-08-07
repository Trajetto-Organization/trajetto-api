import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    coverage: {
      provider: "v8",
      exclude: [
        "infra/scripts",
        "prisma/vitest-environment-prisma/prisma-test-environment.ts",
        "src/config",
        "src/@types",
        "src/env",
        "src/http.ts",
        "src/server.ts",
        "src/shared/providers/mail-provider/implementations/resend-mail-provider.ts",
      ],
    },
    environmentMatchGlobs: [["./tests/E2E/**", "prisma"]],
    setupFiles: ["./setupTests.ts"], // add reflect metadata for all tests
  },
});
