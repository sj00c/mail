import { useEffect, useRef } from "react";
import { api, AuthError, parseAddr, type MailProfile, type MessageSummary } from "../api.ts";

type Options = {
  activeLabel: string;
  query: string;
  composeOpen: boolean;
  onLogout: () => void;
  getCurrentMessages: () => MessageSummary[];
  onRefreshLabels: () => Promise<void> | void;
  onProfile?: (profile: MailProfile) => void;
  onPrependInboxMessages: (messages: MessageSummary[]) => void;
  onActivate: (message: MessageSummary) => void;
};

export function useInboxPoll(options: Options) {
  const optionsRef = useRef(options);
  const lastSeenIds = useRef<string[] | null>(null);
  const newestSeenDate = useRef("");
  const lastProfile = useRef<MailProfile | null>(null);
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
        const profile = await api.profile();
        if (!mounted) return;

        const previousProfile = lastProfile.current;
        const accountChanged =
          previousProfile !== null && previousProfile.email !== profile.email;
        const profileChanged =
          previousProfile === null ||
          accountChanged ||
          !previousProfile.historyId ||
          !profile.historyId ||
          previousProfile.historyId !== profile.historyId;
        if (!profileChanged) {
          optionsRef.current.onProfile?.(profile);
          lastProfile.current = profile;
          return;
        }

        if (accountChanged) {
          lastSeenIds.current = null;
          newestSeenDate.current = "";
        }
        if (!accountChanged &&
          lastSeenIds.current === null &&
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
        const seenIds = lastSeenIds.current;
        let refreshLabels = previousProfile !== null;
        if (top && seenIds && top.id !== seenIds[0]) {
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
            refreshLabels = true;
            optionsRef.current.onPrependInboxMessages(res.messages);
          }
        }
        lastSeenIds.current = res.messages.map((message) => message.id);
        for (const message of res.messages) {
          if (message.date > newestSeenDate.current) newestSeenDate.current = message.date;
        }
        if (refreshLabels) await optionsRef.current.onRefreshLabels();
        if (!mounted) return;
        optionsRef.current.onProfile?.(profile);
        lastProfile.current = profile;
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
