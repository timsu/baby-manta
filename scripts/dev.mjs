import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const shouldOpen = args.includes("open") || args.includes("--open");

const webCommand = shouldOpen
  ? "pnpm --filter @manta/web dev -- --open http://localhost:5173"
  : "pnpm --filter @manta/web dev";

const child = spawn(
  "pnpm",
  [
    "exec",
    "concurrently",
    "-n",
    "server,web",
    "-c",
    "blue,green",
    "pnpm --filter @manta/server dev",
    webCommand,
  ],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
