import { api, onMailMutation, type MessageFull } from "../api.ts";

// Every Gmail round-trip costs ~300ms+ from here, so a thread fetched once
// (or prefetched on hover) is shown instantly the next time. Entries are
// patched in place for the label changes this app makes; anything that can
// change thread membership (send, draft, trash) drops the affected entries.
const FRESH_MS = 60_000;
const MAX_ENTRIES = 60;

type Entry = { at: number; promise: Promise<MessageFull[]>; value?: MessageFull[] };
const entries = new Map<string, Entry>();

function remember(threadId: string, entry: Entry) {
  entries.delete(threadId);
  entries.set(threadId, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

/** Last loaded value, regardless of age (for instant display). */
export function peekThread(threadId: string): MessageFull[] | undefined {
  return entries.get(threadId)?.value;
}

/** Cached promise while fresh, otherwise a new request. Failures are not cached. */
export function loadThread(threadId: string, force = false): Promise<MessageFull[]> {
  const hit = entries.get(threadId);
  if (!force && hit && Date.now() - hit.at < FRESH_MS) return hit.promise;
  const entry: Entry = { at: Date.now(), promise: api.thread(threadId) };
  entry.promise.then(
    (value) => {
      if (entries.get(threadId) === entry) entry.value = value;
    },
    () => {
      if (entries.get(threadId) === entry) entries.delete(threadId);
    },
  );
  remember(threadId, entry);
  return entry.promise;
}

export function prefetchThread(threadId: string): void {
  loadThread(threadId).catch(() => {});
}

/** Mirror a successful label change into every cached copy of the message. */
export function patchCachedMessage(
  messageId: string,
  change: { add?: string[]; remove?: string[] },
): void {
  for (const entry of entries.values()) {
    if (!entry.value?.some((m) => m.id === messageId)) continue;
    entry.value = entry.value.map((m) => {
      if (m.id !== messageId) return m;
      const labels = m.labelIds.filter((l) => !change.remove?.includes(l));
      for (const l of change.add ?? []) if (!labels.includes(l)) labels.push(l);
      return { ...m, labelIds: labels, unread: labels.includes("UNREAD") };
    });
    entry.promise = Promise.resolve(entry.value);
  }
}

export function dropCachedThreads(threadIds?: Iterable<string>): void {
  if (!threadIds) return entries.clear();
  for (const id of threadIds) entries.delete(id);
}

export function dropThreadsContaining(messageIds: Iterable<string>): void {
  const ids = new Set(messageIds);
  for (const [threadId, entry] of entries) {
    if (entry.value?.some((m) => ids.has(m.id))) entries.delete(threadId);
  }
}

onMailMutation((m) => {
  if (m.kind === "labels") for (const id of m.ids) patchCachedMessage(id, m);
  else if (m.kind === "removed") dropThreadsContaining(m.ids);
  else dropCachedThreads();
});
