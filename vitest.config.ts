import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit + integration across all workspace packages. e2e (Playwright) is
    // separate (apps/web/e2e) and not run by `vitest`.
    include: ["apps/**/src/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/*.e2e.test.ts"],
    environment: "node",
    clearMocks: true,
    restoreMocks: true,
  },
});
