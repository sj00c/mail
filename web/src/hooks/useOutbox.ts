import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import type { SendPayload } from "../views/compose.tsx";
import { getUndoSec } from "../lib/settings.ts";

export type OutboxItem = { key: number; payload: SendPayload; draftId?: string };

type Handlers = {
  onSent: () => void;
  onError: (error: unknown) => void;
};

const items: OutboxItem[] = [];
const timers = new Map<number, ReturnType<typeof setTimeout>>();
let subscriber: ((items: OutboxItem[]) => void) | null = null;
let handlers: Handlers | null = null;

function publish() {
  subscriber?.([...items]);
}

function remove(key: number) {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
  const index = items.findIndex((item) => item.key === key);
  if (index >= 0) items.splice(index, 1);
  publish();
}

async function send(item: OutboxItem) {
  remove(item.key);
  try {
    await api.send(item.payload);
    if (item.draftId) await api.deleteDraft(item.draftId).catch(() => {});
    handlers?.onSent();
  } catch (error) {
    handlers?.onError(error);
  }
}

function flush(key: number) {
  const item = items.find((candidate) => candidate.key === key);
  if (item) void send(item);
}

export function useOutbox(currentHandlers: Handlers) {
  const [outbox, setOutbox] = useState<OutboxItem[]>(() => [...items]);
  const handlersRef = useRef(currentHandlers);
  handlersRef.current = currentHandlers;

  useEffect(() => {
    subscriber = setOutbox;
    handlers = handlersRef.current;
    publish();
    return () => {
      if (subscriber === setOutbox) subscriber = null;
      if (handlers === handlersRef.current) handlers = null;
    };
  }, []);
  handlers = handlersRef.current;

  const queueSend = useCallback((payload: SendPayload, draftId?: string) => {
    const item = { key: Date.now() + Math.random(), payload, draftId };
    items.push(item);
    timers.set(item.key, setTimeout(() => flush(item.key), getUndoSec() * 1000));
    publish();
  }, []);
  const cancelSend = useCallback((key: number) => {
    const item = items.find((candidate) => candidate.key === key);
    remove(key);
    return item;
  }, []);
  const sendNow = useCallback((key: number) => flush(key), []);

  return { outbox, queueSend, cancelSend, sendNow };
}
