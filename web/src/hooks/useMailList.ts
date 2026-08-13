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

  messagesRef.current = messages;
  labelRef.current = activeLabel;
  queryRef.current = query;
  nextTokenRef.current = nextToken;
  const getActiveLabel = useCallback(() => labelRef.current, []);
  const getQuery = useCallback(() => queryRef.current, []);

  const load = useCallback(
    (reset: boolean) => {
      const seq = ++loadSeq.current;
      guard(async () => {
        setLoading(true);
        try {
          try {
            const res = await api.messages({
              label:
                queryRef.current || labelRef.current === "ALL"
                  ? undefined
                  : labelRef.current,
              q: queryRef.current || undefined,
              pageToken: reset ? undefined : nextTokenRef.current,
            });
            if (seq !== loadSeq.current) return;
            setMessages((prev) => {
              if (reset) return res.messages;
              const seen = new Set(prev.map((message) => message.id));
              return [...prev, ...res.messages.filter((message) => !seen.has(message.id))];
            });
            setNextToken(res.nextPageToken);
            setTotalEstimate(res.resultSizeEstimate);
          } catch (error) {
            if (seq !== loadSeq.current && !(error instanceof AuthError)) {
              return;
            }
            throw error;
          }
        } finally {
          if (seq === loadSeq.current) setLoading(false);
        }
      });
    },
    [guard],
  );

  const reset = useCallback(() => {
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
