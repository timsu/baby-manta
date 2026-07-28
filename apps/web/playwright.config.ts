import { defineConfig, devices } from "@playwright/test";

// E2E tests are hermetic: every /api call is mocked via page.route (see
// e2e/mockApi.ts), so no manta-server, database, or OAuth is needed — just the
// Vite dev server this config boots. Port 5273 avoids colliding with a real
// dev session on 5173.

const PORT = 5273;

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "list" : [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    // Service workers could bypass route mocks (index.html registers /sw.js).
    serviceWorkers: "block",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `pnpm dev --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
