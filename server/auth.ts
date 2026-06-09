import { OAuth2Client, type Credentials } from "google-auth-library";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

// Scopes: gmail (read/send/label/mark-read/archive/trash; no permanent delete)
// + read-only Google Calendar.
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.readonly",
];

const TOKEN_PATH = join(import.meta.dir, ".data", "token.json");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT =
  process.env.OAUTH_REDIRECT ?? "http://localhost:8787/auth/callback";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.warn(
    "[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set. " +
      "Copy .env.example to .env and fill them in (see README.md).",
  );
}

type StoredToken = {
  refresh_token?: string;
  access_token?: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
};

let client: OAuth2Client | null = null;

function makeClient(): OAuth2Client {
  const c = new OAuth2Client({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT,
  });
  // Persist refreshed tokens automatically.
  c.on("tokens", (tokens) => {
    void mergeAndSave(tokens);
  });
  return c;
}

async function loadToken(): Promise<StoredToken | null> {
  const f = Bun.file(TOKEN_PATH);
  if (!(await f.exists())) return null;
  try {
    return (await f.json()) as StoredToken;
  } catch {
    return null;
  }
}

async function saveToken(tok: StoredToken): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  await Bun.write(TOKEN_PATH, JSON.stringify(tok, null, 2));
}

async function mergeAndSave(tokens: Credentials): Promise<void> {
  const existing = (await loadToken()) ?? {};
  // Google omits refresh_token on refresh responses; keep the stored one.
  const incoming: StoredToken = {
    refresh_token: tokens.refresh_token ?? undefined,
    access_token: tokens.access_token ?? undefined,
    expiry_date: tokens.expiry_date ?? undefined,
    scope: tokens.scope ?? undefined,
    token_type: tokens.token_type ?? undefined,
  };
  const merged: StoredToken = {
    ...existing,
    ...Object.fromEntries(
      Object.entries(incoming).filter(([, v]) => v !== undefined),
    ),
    refresh_token: incoming.refresh_token ?? existing.refresh_token,
  };
  await saveToken(merged);
}

/** Build the consent URL. Forces a refresh_token on first run. */
export function getAuthUrl(): string {
  const c = client ?? (client = makeClient());
  return c.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
  });
}

/** Exchange the ?code= from the OAuth callback and persist tokens. */
export async function handleCallback(code: string): Promise<void> {
  const c = client ?? (client = makeClient());
  const { tokens } = await c.getToken(code);
  c.setCredentials(tokens);
  await mergeAndSave(tokens);
}

/** True once we have a refresh token on disk. */
export async function isAuthed(): Promise<boolean> {
  const tok = await loadToken();
  return Boolean(tok?.refresh_token);
}

export async function logout(): Promise<void> {
  const f = Bun.file(TOKEN_PATH);
  if (await f.exists()) await Bun.write(TOKEN_PATH, "{}");
  client = null;
}

/**
 * Return an authorized client ready for Gmail API calls.
 * Throws if not authenticated yet.
 */
export async function getAuthedClient(): Promise<OAuth2Client> {
  const tok = await loadToken();
  if (!tok?.refresh_token) {
    throw new Error("NOT_AUTHENTICATED");
  }
  const c = client ?? (client = makeClient());
  c.setCredentials(tok);
  return c;
}
