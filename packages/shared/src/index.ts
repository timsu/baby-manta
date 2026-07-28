export * from "./kanban.ts";
export * from "./events.ts";
// NOTE: ./setup is intentionally NOT re-exported here — it pulls in node:
// built-ins (child_process), and this index is imported by the browser app.
// Server/daemon import it directly via "@manta/shared/setup".
