import { useCallback, useEffect, useRef, useState } from "react";
import { api, AuthError, type MessageSummary } from "../api.ts";

type Guard = (fn: () => Promise<void>) => void;
export function shouldRemoveArchivedMessage(activeLabel: string, query: string) {
  return activeLabel === "INBOX" && query.length === 0;
}

// Last loaded page per mailbox view. Returning to a label shows these rows at
// once while the first page is refetched; the fetch then replaces them.
type ListSnapshot = {
  messages: MessageSummary[];
  nextToken?: string;
  totalEstimate: number;
};
const MAX_VIEWS = 12;
const viewKey = (label: string, query: string) => `${label}\u0000${query}`;

export function useMailList(activeLabel: string, query: string, guard: Guard) {
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [nextToken, setNextToken] = useState<string | undefined>();
  const [totalEstimate, setTotalEstimate] = useState(0);
  const [loading, setLoading] = useState(false);
  const messagesRef = useRef(messages);
  const labelRef = useRef(activeLabel);
  const queryRef = useRef(query);
  const nextTokenRef = useRef(nextToken);
  const loadSeq = useRef(0);
  const appendInFlight = useRef(new Map<string, number>());
  const resetInFlight = useRef<number | null>(null);
  const snapshots = useRef(new Map<string, ListSnapshot>());
  // The view the rows in `messages` belong to. labelRef switches during the
  // render that changes labels, before reset() swaps the rows, so it cannot
  // be used to file a snapshot.
  const ownerKey = useRef(viewKey(activeLabel, query));

  messagesRef.current = messages;
  labelRef.current = activeLabel;
  queryRef.current = query;
  nextTokenRef.current = nextToken;
  const getActiveLabel = useCallback(() => labelRef.current, []);
  const getQuery = useCallback(() => queryRef.current, []);

  const load = useCallback(
    (reset: boolean) => {
      const label = labelRef.current;
      const query = queryRef.current;
      const pageToken = reset ? undefined : nextTokenRef.current;
      if (!reset && resetInFlight.current !== null) return;
      if (!reset && pageToken === undefined) return;
      const appendKey = reset ? null : `${label}\u0000${query}\u0000${pageToken}`;
      if (appendKey !== null && appendInFlight.current.has(appendKey)) return;

      const seq = ++loadSeq.current;
      if (reset) {
        resetInFlight.current = seq;
        appendInFlight.current.clear();
      } else {
        appendInFlight.current.set(appendKey!, seq);
      }
      guard(async () => {
        setLoading(true);
        try {
          try {
            const res = await api.messages({
              label: query || label === "ALL" ? undefined : label,
              q: query || undefined,
              pageToken,
            });
            if (seq !== loadSeq.current) return;
            ownerKey.current = viewKey(label, query);
            const nextMessages = reset
              ? res.messages
              : (() => {
                  const seen = new Set(messagesRef.current.map((message) => message.id));
                  return [
                    ...messagesRef.current,
                    ...res.messages.filter((message) => !seen.has(message.id)),
                  ];
                })();
            messagesRef.current = nextMessages;
            nextTokenRef.current = res.nextPageToken;
            setMessages(nextMessages);
            setNextToken(res.nextPageToken);
            setTotalEstimate(res.resultSizeEstimate);
          } catch (error) {
            if (seq !== loadSeq.current && !(error instanceof AuthError)) {
              return;
            }
            throw error;
          }
        } finally {
          if (reset && resetInFlight.current === seq) resetInFlight.current = null;
          if (appendKey !== null && appendInFlight.current.get(appendKey) === seq) {
            appendInFlight.current.delete(appendKey);
          }
          if (seq === loadSeq.current) setLoading(false);
        }
      });
    },
    [guard],
  );

  const reset = useCallback(() => {
    ++loadSeq.current;
    resetInFlight.current = null;
    appendInFlight.current.clear();
    ownerKey.current = viewKey(labelRef.current, queryRef.current);
    const hit = snapshots.current.get(ownerKey.current);
    messagesRef.current = hit?.messages ?? [];
    nextTokenRef.current = hit?.nextToken;
    setMessages(messagesRef.current);
    setNextToken(nextTokenRef.current);
    setTotalEstimate(hit?.totalEstimate ?? 0);
  }, []);

  // Keep the snapshot of the current view in step with every confirmed
  // change (pages, optimistic patches, removals). While a reset is in flight
  // the rows on screen are a snapshot themselves, so nothing is written back.
  useEffect(() => {
    if (resetInFlight.current !== null) return;
    const key = ownerKey.current;
    const map = snapshots.current;
    map.delete(key);
    map.set(key, { messages, nextToken, totalEstimate });
    while (map.size > MAX_VIEWS) map.delete(map.keys().next().value!);
  }, [messages, nextToken, totalEstimate]);
  const patchMessage = useCallback((id: string, patch: Partial<MessageSummary>) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }, []);
  const removeMessage = useCallback((id: string) => {
    setMessages((prev) => prev.filter((message) => message.id !== id));
  }, []);
  const patchMany = useCallback((ids: Set<string>, patch: Partial<MessageSummary>) => {
    setMessages((prev) => prev.map((message) => (ids.has(message.id) ? { ...message, ...patch } : message)));
  }, []);
  const removeMany = useCallback((ids: Set<string>) => {
    setMessages((prev) => prev.filter((message) => !ids.has(message.id)));
  }, []);
  const toggleLabelMany = useCallback((ids: Set<string>, label: string, add: boolean) => {
    setMessages((prev) =>
      prev.map((message) => {
        if (!ids.has(message.id)) return message;
        const has = message.labelIds.includes(label);
        if (add && !has) return { ...message, labelIds: [...message.labelIds, label] };
        if (!add && has) return { ...message, labelIds: message.labelIds.filter((id) => id !== label) };
        return message;
      }),
    );
  }, []);
  const prependInboxMessages = useCallback((incoming: MessageSummary[]) => {
    if (labelRef.current !== "INBOX" || queryRef.current) return;
    setMessages((prev) => {
      const existing = new Set(prev.map((message) => message.id));
      const added = incoming.filter((message) => !existing.has(message.id));
      return added.length ? [...added, ...prev] : prev;
    });
  }, []);
  const getMessages = useCallback(() => messagesRef.current, []);
  const getNextToken = useCallback(() => nextTokenRef.current, []);

  return {
    messages,
    nextToken,
    totalEstimate,
    loading,
    getMessages,
    getNextToken,
    getActiveLabel,
    getQuery,
    load,
    reset,
    patchMessage,
    removeMessage,
    patchMany,
    removeMany,
    toggleLabelMany,
    prependInboxMessages,
  };
}
