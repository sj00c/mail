import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp, mountProductionStatic } from "./app.ts";

const DEFAULT_PORT = 8787;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function resolvePort(raw: string | undefined): number {
  const value = raw ?? String(DEFAULT_PORT);
  if (!/^\d+$/.test(value)) {
    throw new Error(
      "[server] Invalid PORT. PORT must be a decimal integer from 1024 to 65535.",
    );
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      "[server] Invalid PORT. PORT must be a decimal integer from 1024 to 65535.",
    );
  }
  return port;
}

function resolveHost(raw: string | undefined): string {
  const host = raw ?? "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      "[server] Invalid HOST. HOST must be one of 127.0.0.1, localhost, or ::1.",
    );
  }
  return host;
}

const port = resolvePort(process.env.PORT);
const hostname = resolveHost(process.env.HOST);
const isProduction = process.env.NODE_ENV === "production";
const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const appUrl =
  process.env.APP_URL ?? (isProduction ? "/" : "http://localhost:5173/");

if (isProduction && !existsSync(join(dist, "index.html"))) {
  throw new Error(
    `[server] Production build missing: ${join(dist, "index.html")}. ` +
      'Run "bun run build" or reinstall the application before starting the server.',
  );
}

const app = createApp(appUrl);
if (isProduction) await mountProductionStatic(app, dist);

const displayHostname = hostname === "::1" ? "[::1]" : hostname;
console.log(`[server] http://${displayHostname}:${port}`);
export default { port, hostname, fetch: app.fetch };
