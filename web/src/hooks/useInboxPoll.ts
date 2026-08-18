import { useEffect, useRef } from "react";
import { api, AuthError, parseAddr, type MessageSummary } from "../api.ts";

type Options = {
  activeLabel: string;
  query: string;
  composeOpen: boolean;
  onLogout: () => void;
  getCurrentMessages: () => MessageSummary[];
  onRefreshLabels: () => void;
  onPrependInboxMessages: (messages: MessageSummary[]) => void;
  onActivate: (message: MessageSummary) => void;
};

export function useInboxPoll(options: Options) {
  const optionsRef = useRef(options);
  const lastSeenIds = useRef<string[] | null>(null);
  const newestSeenDate = useRef("");
  optionsRef.current = options;

  useEffect(() => {
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let inFlight = false;
    const tick = async () => {
      if (document.visibilityState !== "visible" || inFlight) return;
      inFlight = true;
      try {
        if (lastSeenIds.current === null &&
          optionsRef.current.activeLabel === "INBOX" &&
          !optionsRef.current.query) {
          const current = optionsRef.current.getCurrentMessages();
          lastSeenIds.current = current.slice(0, 5).map((message) => message.id);
          newestSeenDate.current = current.reduce(
            (newest, message) => message.date > newest ? message.date : newest,
            newestSeenDate.current,
          );
        }
        const res = await api.messages({ label: "INBOX", maxResults: 5 });
        if (!mounted) return;
        const top = res.messages[0];
        if (!top) return;
        const seenIds = lastSeenIds.current;
        if (seenIds && top.id !== seenIds[0]) {
          const fresh = res.messages.filter((message) => !seenIds.includes(message.id));
          const freshNew = fresh.filter((message) => message.date > newestSeenDate.current);
          if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            for (const message of freshNew.filter((item) => item.unread).slice(0, 3)) {
              const notification = new Notification(parseAddr(message.from).name, {
                body: message.subject || message.snippet,
                tag: message.id,
              });
              notification.onclick = () => {
                window.focus();
                optionsRef.current.onActivate(message);
                notification.close();
              };
            }
          }
          if (fresh.length > 0) {
            optionsRef.current.onRefreshLabels();
            optionsRef.current.onPrependInboxMessages(res.messages);
          }
        }
        lastSeenIds.current = res.messages.map((message) => message.id);
        for (const message of res.messages) {
          if (message.date > newestSeenDate.current) newestSeenDate.current = message.date;
        }
      } catch (error) {
        if (error instanceof AuthError && !optionsRef.current.composeOpen) optionsRef.current.onLogout();
      } finally {
        inFlight = false;
      }
    };
    const interval = setInterval(tick, 60_000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);
}
