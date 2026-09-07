import { useCallback, useRef, useState } from "react";
import { api, AuthError, type MessageSummary } from "../api.ts";

type Guard = (fn: () => Promise<void>) => void;
export function shouldRemoveArchivedMessage(activeLabel: string, query: string) {
  return activeLabel === "INBOX" && query.length === 0;
}

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
    messagesRef.current = [];
    nextTokenRef.current = undefined;
    setMessages([]);
    setNextToken(undefined);
  }, []);
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
