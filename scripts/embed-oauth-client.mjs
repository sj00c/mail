#!/usr/bin/env node
// Writes dist/oauth-client.json for release packages from the publisher's
// Google OAuth desktop client. The values come from BUNDLED_GOOGLE_CLIENT_ID /
// BUNDLED_GOOGLE_CLIENT_SECRET in the environment (CI secrets) or the
// repository .env, never from source. Without them the package ships no
// client and setup asks each user for their own.
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = join(root, "dist", "oauth-client.json");

const fromFile = {};
const envFile = join(root, ".env");
if (existsSync(envFile)) {
  for (const raw of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const separator = line.indexOf("=");
    if (!line || line.startsWith("#") || separator < 1) continue;
    fromFile[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
}
const clientId = process.env.BUNDLED_GOOGLE_CLIENT_ID || fromFile.BUNDLED_GOOGLE_CLIENT_ID || "";
const clientSecret = process.env.BUNDLED_GOOGLE_CLIENT_SECRET || fromFile.BUNDLED_GOOGLE_CLIENT_SECRET || "";

if (!clientId && !clientSecret) {
  rmSync(output, { force: true });
  console.log("No bundled Google client (BUNDLED_GOOGLE_CLIENT_ID/SECRET unset); users enter their own.");
  process.exit(0);
}
if (!clientId || !clientSecret) {
  console.error("Set both BUNDLED_GOOGLE_CLIENT_ID and BUNDLED_GOOGLE_CLIENT_SECRET, or neither.");
  process.exit(1);
}
if (!clientId.endsWith(".apps.googleusercontent.com") || /[\s"']/.test(clientId + clientSecret)) {
  console.error("BUNDLED_GOOGLE_CLIENT_ID must end with .apps.googleusercontent.com, without quotes or spaces.");
  process.exit(1);
}
if (!existsSync(join(root, "dist", "index.html"))) {
  console.error("Build first: dist/index.html is missing.");
  process.exit(1);
}
writeFileSync(output, `${JSON.stringify({ clientId, clientSecret }, null, 2)}\n`);
console.log("Bundled the Google OAuth client into dist/oauth-client.json.");
