import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// Default: proxy API + WS to the local manta-server.
//
// Prod-data mode: point the local web app (e.g. dog mode) at production so you
// see your real board without deploying. Grab your `manta_session` cookie from
// manta.example.com (devtools → Application → Cookies) and run:
//
//   MANTA_PROD_PROXY=1 MANTA_PROD_COOKIE="manta_session=<value>" pnpm --filter @manta/web dev
//
// Requests carry your real prod session — treat writes accordingly.
const PROD_ORIGIN = process.env.MANTA_PROD_ORIGIN ?? "https://manta.example.com";
const prodMode = process.env.MANTA_PROD_PROXY === "1";
const prodCookie = process.env.MANTA_PROD_COOKIE;

function target(local: string, ws = false): ProxyOptions {
  if (!prodMode) return ws ? { target: local.replace("http", "ws"), ws: true } : { target: local };
  const base: ProxyOptions = {
    target: ws ? PROD_ORIGIN.replace("https", "wss") : PROD_ORIGIN,
    changeOrigin: true,
    ws,
    headers: prodCookie ? { cookie: prodCookie } : undefined,
    configure(proxy) {
      // vite's ws proxying doesn't apply `headers` to upgrade requests.
      proxy.on("proxyReqWs", (proxyReq) => {
        if (prodCookie) proxyReq.setHeader("cookie", prodCookie);
      });
    },
  };
  return base;
}

if (prodMode && !prodCookie) {
  console.warn("[manta] MANTA_PROD_PROXY=1 but MANTA_PROD_COOKIE is unset — prod requests will be unauthenticated.");
}
if (prodMode) {
  console.log(`[manta] DEV PROXY → ${PROD_ORIGIN} (production data; writes are real)`);
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": target("http://localhost:3020"),
      "/_ping": target("http://localhost:3020"),
      "/ws": target("http://localhost:3020", true),
      "/terminal": target("http://localhost:3020", true),
      "/worker-ws": target("http://localhost:3020", true),
    },
  },
});
