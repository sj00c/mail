import { OAuth2Client, type Credentials } from "google-auth-library";
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

// Scopes: gmail (read/send/label/mark-read/archive/trash; no permanent delete)
// + Google Calendar read/write (create/update/delete events)
// + Google Drive read/write (browse/upload/download/trash + share-link for large
//   mail attachments). Full `drive` (not drive.file) so the Drive tab can list
//   pre-existing files, not just ones this app created.
// + contacts read-only (둘 다): 받는사람 자동완성 — 주소록(contacts) +
//   "자주 주고받은 주소"(contacts.other, Gmail이 자동 수집한 목록).
export const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
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
    // Access token revoked before expiry_date (password change, manual revoke):
    // retry once with a forced refresh instead of bricking until the hour mark.
    forceRefreshOnFailure: true,
  });
  // Persist refreshed tokens automatically. A failed persist must not become
  // an unhandled rejection (it would take the whole server down).
  c.on("tokens", (tokens) => {
    mergeAndSave(tokens).catch((err) => {
      console.error("[auth] token persist failed:", err);
    });
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

// token.json read-modify-writes are serialized and the write is atomic
// (tmp + rename): concurrent refreshes must never interleave merges or leave
// a torn file that drops the refresh token.
let tokenOp: Promise<unknown> = Promise.resolve();
function serializedTokenOp<T>(fn: () => Promise<T>): Promise<T> {
  const p = tokenOp.then(fn, fn);
  tokenOp = p.catch(() => {});
  return p;
}

async function saveToken(tok: StoredToken): Promise<void> {
  await mkdir(dirname(TOKEN_PATH), { recursive: true });
  const tmp = `${TOKEN_PATH}.tmp`;
  await Bun.write(tmp, JSON.stringify(tok, null, 2));
  await rename(tmp, TOKEN_PATH);
}

function mergeAndSave(tokens: Credentials): Promise<void> {
  return serializedTokenOp(() => mergeAndSaveInner(tokens));
}

async function mergeAndSaveInner(tokens: Credentials): Promise<void> {
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

// CSRF protection for the OAuth flow: the callback only accepts codes whose
// `state` we minted ourselves (otherwise any page could silently log this app
// into an attacker's account by navigating to the callback URL).
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60_000;

/** True (and consumed) iff `state` came from a recent getAuthUrl() call. */
export function consumeOAuthState(state: string | undefined): boolean {
  const now = Date.now();
  for (const [s, at] of pendingStates) {
    if (now - at > STATE_TTL_MS) pendingStates.delete(s);
  }
  if (!state || !pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

/** Build the consent URL. Forces a refresh_token on first run. */
export function getAuthUrl(): string {
  const c = client ?? (client = makeClient());
  const state = crypto.randomUUID();
  pendingStates.set(state, Date.now());
  return c.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
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
  await serializedTokenOp(async () => {
    const f = Bun.file(TOKEN_PATH);
    if (await f.exists()) await Bun.write(TOKEN_PATH, "{}");
  });
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
