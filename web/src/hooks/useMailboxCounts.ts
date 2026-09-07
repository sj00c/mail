import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Label, type MailProfile } from "../api.ts";

/** Coalesce bursts of mutations, but never publish a pre-mutation count response. */
export function useMailboxCounts() {
  const [labels, setLabels] = useState<Label[]>([]);
  const [messagesTotal, setMessagesTotal] = useState<number | null>(null);
  const mounted = useRef(false);
  const pending = useRef<Promise<void> | null>(null);
  const revision = useRef(0);
  const needsProfile = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; revision.current++; };
  }, []);

  const applyProfile = useCallback((profile: MailProfile) => {
    if (mounted.current) {
      revision.current++;
      setMessagesTotal(profile.messagesTotal);
    }
  }, []);

  const refresh = useCallback((includeProfile = true): Promise<void> => {
    revision.current++;
    needsProfile.current ||= includeProfile;
    if (pending.current) return pending.current;
    const work = async () => {
      while (mounted.current) {
        const requestRevision = revision.current;
        const fetchProfile = needsProfile.current;
        needsProfile.current = false;
        const [nextLabels, profile] = await Promise.all([
          api.labels(),
          fetchProfile ? api.profile() : Promise.resolve(null),
        ]);
        if (!mounted.current) return;
        if (requestRevision !== revision.current) {
          needsProfile.current ||= fetchProfile;
          continue;
        }
        setLabels(nextLabels);
        if (profile) setMessagesTotal(profile.messagesTotal);
        return;
      }
    };
    pending.current = work().finally(() => { pending.current = null; });
    return pending.current;
  }, []);

  return { labels, messagesTotal, applyProfile, refresh };
}
