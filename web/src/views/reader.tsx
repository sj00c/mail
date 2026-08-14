// 읽기 화면: 목록 행, 대화 스레드, HTML/평문 본문 렌더러, 답장 대상 계산.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  AuthError,
  parseAddr,
  splitAddrList,
  type MessageFull,
  type MessageSummary,
} from "../api.ts";
import { downloadAttachment, saveAttachment } from "../lib/attachments.ts";
import { avatarColor, DATETIME_FMT, listDateLabel } from "../lib/format.tsx";
import {
  directMessageHtml,
  directMessageText,
  fwdSubject,
  linkifyParts,
  prepareEmailHtml,
  replyReferences,
  reSubject,
  rewriteCidRefs,
} from "../lib/mailHtml.ts";
import {
  AlertIcon,
  ArchiveIcon,
  AttachmentIcon,
  BanIcon,
  CalendarIcon,
  CloudIcon,
  MailIcon,
  RestoreIcon,
  TrashIcon,
} from "../ui/icons.tsx";
import type { ComposeInit } from "./compose.tsx";

// 목록/카드에 표시할 상대방: 보낸함·임시보관함(내가 보낸 것)은 받는사람을,
// 그 외에는 보낸사람을 보여준다. 수신자가 여럿이면 "이름 외 N명".
export function listParty(m: MessageSummary): { name: string; email: string } {
  const outgoing = m.labelIds.includes("SENT") || m.labelIds.includes("DRAFT");
  const raw = outgoing ? m.to : m.from;
  const toks = splitAddrList(raw);
  if (toks.length === 0) return { name: outgoing ? "(받는사람 없음)" : "(보낸사람 없음)", email: "" };
  const first = parseAddr(toks[0]);
  const name =
    toks.length > 1 ? `${first.name} 외 ${toks.length - 1}명` : first.name;
  return { name, email: first.email };
}

export const MessageRow = memo(function MessageRow({
  m,
  active,
  checked,
  onSelect,
  onToggleCheck,
}: {
  m: MessageSummary;
  active: boolean;
  checked: boolean;
  onSelect: (id: string, threadId: string) => void;
  onToggleCheck: (id: string, shiftKey: boolean) => void;
}) {
  const addr = listParty(m);
  const label = listDateLabel(m.date);
  // 행 자체는 button을 못 쓴다 — 안에 체크박스(인터랙티브)가 들어가 nesting
  // 위반이 되므로 div + role/tabIndex로 동일한 키보드 동작을 준다.
  return (
    <div
      className={`msg-row ${active ? "active" : ""} ${m.unread ? "unread" : ""} ${
        checked ? "checked" : ""
      }`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(m.id, m.threadId)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(m.id, m.threadId);
        }
      }}
    >
      {/* 항상 보이는 전용 선택 칸. 클릭은 이 셀이 받고(행 높이만큼 넓은 영역),
          체크박스는 시각 표시만(pointer-events:none) 한다. */}
      <span
        className="msg-check-cell"
        role="checkbox"
        aria-checked={checked}
        aria-label={`${addr.name || addr.email} 선택`}
        onClick={(e) => {
          e.stopPropagation(); // 행 클릭(리더 열기)으로 번지지 않게
          onToggleCheck(m.id, e.shiftKey);
        }}
      >
        <input type="checkbox" className="msg-check" checked={checked} tabIndex={-1} readOnly />
      </span>
      <span
        className="avatar sm"
        style={{ background: avatarColor(addr.email.toLowerCase()) }}
      >
        {(addr.name || "?").trim().charAt(0).toUpperCase()}
      </span>
      <span className="msg-main">
        <span className="msg-top">
          <span className="msg-from">{addr.name}</span>
          <span
            className={`msg-read-state ${m.unread ? "unread" : "read"}`}
            title={m.unread ? "안읽은 메일" : "읽은 메일"}
          >
            <span className="msg-read-dot" />
            {m.unread ? "안읽음" : "읽음"}
          </span>
          <span className="msg-date">{label}</span>
        </span>
        <span className="msg-subject">
          {m.subject || "(제목 없음)"}
          {m.hasAttachments && <span className="paperclip"><AttachmentIcon /></span>}
        </span>
        <span className="msg-snippet">{m.snippet}</span>
      </span>
    </div>
  );
});

export function Reader({
  id,
  threadId,
  ownAddresses,
  inTrash,
  guard,
  onPatched,
  onRemoved,
  onReply,
  onCreateEvent,
  onClose,
}: {
  id: string;
  threadId: string;
  ownAddresses: string[];
  inTrash: boolean;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onPatched: (id: string, patch: Partial<MessageSummary>) => void;
  onRemoved: (id: string, scope: "inbox" | "trash" | "all") => void;
  onReply: (init: ComposeInit) => void;
  onCreateEvent: (m: MessageFull) => void;
  onClose: () => void;
}) {
  const [msg, setMsg] = useState<MessageFull | null>(null);
  const [thread, setThread] = useState<MessageFull[] | null>(null);
  // 펼쳐 둘 메일 id — 기본은 "지금 연 메일 + 대화의 마지막 메일"이고
  // 나머지는 한 줄 요약으로 접힌다.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loadErr, setLoadErr] = useState<string | null>(null);

  useEffect(() => {
    // Cancellation guard: without it, a slow thread fetch for a previously
    // clicked message lands after a newer selection rendered, replacing the
    // view while the action buttons still target the new `id` — 삭제/보관
    // would silently operate on a different mail than the one displayed.
    let cancelled = false;
    setMsg(null);
    setThread(null);
    setLoadErr(null);
    void (async () => {
      try {
        // One round-trip: the thread already contains the opened message
        // (previously message + thread were fetched, duplicating the payload).
        const msgs = await api.thread(threadId);
        if (cancelled) return;
        const m = msgs.find((x) => x.id === id);
        if (!m) {
          // Deleted between list render and open, or id/thread mismatch.
          setLoadErr("메시지를 찾을 수 없습니다. 목록을 새로고침하세요.");
          return;
        }
        setMsg(m);
        setThread(msgs);
        setExpanded(new Set([m.id, msgs[msgs.length - 1].id]));
        if (m.unread) {
          try {
            await api.modify(m.id, { remove: ["UNREAD"] });
            // List state belongs to Mailbox — reflect the (already applied)
            // server change even when this Reader was superseded meanwhile.
            onPatched(m.id, { unread: false });
            if (cancelled) return;
            setMsg((prev) => (prev ? { ...prev, unread: false } : prev));
            setThread((prev) =>
              prev?.map((tm) => (tm.id === m.id ? { ...tm, unread: false } : tm)) ??
              prev,
            );
          } catch (e) {
            if (!cancelled && e instanceof AuthError) {
              void guard(() => Promise.reject(e)); // route to logout
            }
            // mark-read failure is non-fatal — the mail stays unread
          }
        }
      } catch (e) {
        if (cancelled) return;
        if (e instanceof AuthError) {
          void guard(() => Promise.reject(e)); // route to logout
          return;
        }
        // Render the failure instead of spinning on "불러오는 중…" forever.
        setLoadErr((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, threadId]);

  // 대화 목록과 답장 깊이는 렌더마다 다시 계산할 이유가 없다. 콜백도 고정해야
  // memo(ThreadMessage)가 실제로 먹는다 — 메시지마다 iframe이 하나씩 붙는다.
  const msgs = useMemo(() => thread ?? (msg ? [msg] : []), [thread, msg]);
  const depths = useMemo(() => replyDepths(msgs), [msgs]);
  const toggleExpanded = useCallback((mid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(mid)) next.delete(mid);
      else next.add(mid);
      return next;
    });
  }, []);
  const composeTo = useCallback((email: string) => onReply({ to: email }), [onReply]);

  if (loadErr) return <div className="empty"><AlertIcon />{loadErr}</div>;
  if (!msg) return <div className="empty">불러오는 중…</div>;

  return (
    <div className="reader-inner">
      <div className="reader-head">
        <h2>{msg.subject || "(제목 없음)"}</h2>
        <div className="reader-actions">
          <button className="btn" onClick={() => onReply(buildReplyInit(msg, ownAddresses, false))}>
            ↩ 답장
          </button>
          <button className="btn" onClick={() => onReply(buildReplyInit(msg, ownAddresses, true))}>
            ↩↩ 전체답장
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                // Forward carries everything: file attachments AND inline cid:
                // images (re-related on send) so the original renders intact.
                const attachments = await Promise.all(
                  msg.attachments.map((a) => downloadAttachment(msg.id, a)),
                );
                onReply({
                  subject: fwdSubject(msg.subject),
                  forward: true,
                  quoteHtml: directMessageHtml(msg),
                  quoteFrom: msg.from,
                  quoteDate: msg.date,
                  quoteTo: msg.to,
                  quoteSubject: msg.subject,
                  attachments,
                });
              })
            }
          >
            ↪ 전달
          </button>
          <button
            className="btn"
            title="이 메일 내용으로 캘린더 일정 만들기"
            onClick={() => onCreateEvent(msg)}
          >
            <CalendarIcon />일정
          </button>
          {thread && thread.length > 1 && (
            <button
              className="btn"
              title="이 대화의 모든 메시지를 시간순으로 묶어 전달"
              onClick={() =>
                guard(async () => {
                  // Content-IDs are scoped to one source message. Namespace and
                  // rewrite each message before combining, or equal CIDs from two
                  // replies can display the wrong inline image.
                  const forwarded = await Promise.all(
                    thread.map(async (tm, index) => {
                      const downloaded = await Promise.all(
                        tm.attachments.map((a) => downloadAttachment(tm.id, a)),
                      );
                      const cidMap = new Map<string, string>();
                      const attachments = downloaded.map((a) => {
                        if (!a.contentId) return a;
                        const next = `fwd-${index}-${crypto.randomUUID()}@mail.local`;
                        cidMap.set(a.contentId, next);
                        return { ...a, contentId: next };
                      });
                      return {
                        message: tm,
                        bodyHtml: rewriteCidRefs(directMessageHtml(tm), cidMap),
                        attachments,
                      };
                    }),
                  );
                  onReply({
                    subject: fwdSubject(msg.subject),
                    forwardThread: true,
                    quoteHtml: threadQuoteHtml(forwarded),
                    quoteSubject: msg.subject,
                    attachments: forwarded.flatMap((f) => f.attachments),
                  });
                })
              }
            >
              ↪↪ 전체 전달
            </button>
          )}
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                const starred = msg.labelIds.includes("STARRED");
                await api.modify(id, {
                  add: starred ? [] : ["STARRED"],
                  remove: starred ? ["STARRED"] : [],
                });
                // Functional update: an overlapping action (읽음 toggle) must
                // not be reverted by spreading this click's stale snapshot.
                setMsg((prev) =>
                  prev
                    ? {
                        ...prev,
                        labelIds: starred
                          ? prev.labelIds.filter((l) => l !== "STARRED")
                          : [...prev.labelIds, "STARRED"],
                      }
                    : prev,
                );
                onPatched(id, {
                  labelIds: starred
                    ? msg.labelIds.filter((l) => l !== "STARRED")
                    : [...msg.labelIds, "STARRED"],
                });
              })
            }
          >
            {msg.labelIds.includes("STARRED") ? "★ 별표 해제" : "☆ 별표"}
          </button>
          <button
            className="btn"
            onClick={() =>
              guard(async () => {
                const wasUnread = msg.unread;
                await api.modify(id, {
                  add: wasUnread ? [] : ["UNREAD"],
                  remove: wasUnread ? ["UNREAD"] : [],
                });
                setMsg((prev) => (prev ? { ...prev, unread: !wasUnread } : prev));
                setThread((prev) =>
                  prev?.map((tm) =>
                    tm.id === id ? { ...tm, unread: !wasUnread } : tm,
                  ) ?? prev,
                );
                onPatched(id, { unread: !wasUnread });
              })
            }
          >
            <MailIcon />{msg.unread ? "읽음" : "안읽음"}
          </button>
          {inTrash ? (
            // 휴지통: trash/보관/스팸은 모두 no-op이므로 '복원'만 노출.
            <button
              className="btn"
              onClick={() =>
                guard(async () => {
                  await api.modify(id, { add: ["INBOX"], remove: ["TRASH"] });
                  onRemoved(id, "all");
                  onClose();
                })
              }
            >
              <RestoreIcon />받은편지함으로 복원
            </button>
          ) : (
            <>
              <button
                className="btn"
                onClick={() =>
                  guard(async () => {
                    await api.modify(id, { remove: ["INBOX"] });
                    onRemoved(id, "inbox");
                    onClose();
                  })
                }
              >
                <ArchiveIcon />보관
              </button>
              <button
                className="btn"
                onClick={() =>
                  guard(async () => {
                    const isSpam = msg.labelIds.includes("SPAM");
                    await api.modify(id, {
                      add: isSpam ? ["INBOX"] : ["SPAM"],
                      remove: isSpam ? ["SPAM"] : ["INBOX"],
                    });
                    onRemoved(id, "all");
                    onClose();
                  })
                }
              >
                <BanIcon />{msg.labelIds.includes("SPAM") ? "스팸 아님" : "스팸"}
              </button>
              <button
                className="btn danger"
                onClick={() =>
                  guard(async () => {
                    await api.trash(id);
                    onRemoved(id, "trash");
                    onClose();
                  })
                }
              >
                <TrashIcon />삭제
              </button>
            </>
          )}
        </div>
      </div>
      {msgs.length > 1 && (
        <div className="thread-bar">
          <span className="thread-bar-title">
            💬 대화 <b>{msgs.length}개</b>
            {expanded.size < msgs.length && ` · ${expanded.size}개 펼침`}
          </span>
          <span className="modal-spacer" />
          <button
            type="button"
            className="btn sm"
            onClick={() => setExpanded(new Set(msgs.map((t) => t.id)))}
          >
            모두 펼치기
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => setExpanded(new Set([msg.id]))}
          >
            이 메일만
          </button>
        </div>
      )}
      {msgs.map((tm, i) => (
        <ThreadMessage
          key={tm.id}
          m={tm}
          depth={depths.get(tm.id) ?? 0}
          index={i}
          total={msgs.length}
          // 열어 본 메일 + 마지막 메일만 펼친 채 시작한다 (대화 하나가
          // 통째로 쏟아지지 않게). 나머지는 한 줄 요약 → 눌러서 확인.
          collapsed={msgs.length > 1 && !expanded.has(tm.id)}
          onToggle={toggleExpanded}
          guard={guard}
          onComposeTo={composeTo}
        />
      ))}
    </div>
  );
}

// 전체 전달: 각 메일의 직접 작성한 본문만 독립 카드로 조립한다.
// 각 메일에 내장된 과거 인용까지 다시 합치면 같은 대화가 N번씩 중첩된다.
export function threadQuoteHtml(
  msgs: { message: MessageFull; bodyHtml: string }[],
): string {
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    `<div class="mail-fwd-thread" style="margin-top:16px">` +
    `<div style="font-size:12px;font-weight:700;letter-spacing:.3px;color:#5f6368;margin-bottom:10px">전달된 대화 · ${msgs.length}개 메일</div>` +
    msgs
      .map(({ message: m, bodyHtml }, index) => {
        const addr = parseAddr(m.from);
        const when = DATETIME_FMT.format(new Date(m.date));
        const body = bodyHtml;
        return (
          `<section style="border:1px solid #dfe3eb;border-radius:10px;overflow:hidden;margin:0 0 12px;background:#fff">` +
          `<div style="background:#f6f8fb;border-bottom:1px solid #e3e7ee;padding:10px 12px;font-size:12.5px;line-height:1.65;color:#5f6368">` +
          `<div style="font-weight:700;color:#202124">${index + 1}. ${esc(addr.name || addr.email)} &lt;${esc(addr.email)}&gt;</div>` +
          `<div>${esc(when)}</div>` +
          `<div>받는사람: ${esc(m.to)}${m.cc ? `<br>참조: ${esc(m.cc)}` : ""}</div>` +
          `<div>제목: ${esc(m.subject || "(제목 없음)")}</div>` +
          `</div>` +
          `<div style="padding:12px 14px">${body}</div>` +
          `</section>`
        );
      })
      .join("") +
    `</div>`
  );
}

// Reply / reply-all targets:
// - own sent mail → continue with the original recipients, not yourself
// - otherwise honor Reply-To over From
// - reply-all: everyone else (minus me and the To target), comma-safe split
export function buildReplyInit(
  msg: MessageFull,
  ownAddresses: string[],
  all: boolean,
): ComposeInit {
  const own = new Set(ownAddresses.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const fromMe = own.has(parseAddr(msg.from).email.toLowerCase());
  const to = (fromMe ? msg.to : msg.replyTo || msg.from).trim();
  let cc: string | undefined;
  if (all) {
    const toEmails = new Set(
      splitAddrList(to).map((t) => parseAddr(t).email.toLowerCase()),
    );
    const seen = new Set<string>();
    const rest = [...splitAddrList(msg.to), ...splitAddrList(msg.cc || "")].filter(
      (tok) => {
        const e = parseAddr(tok).email.toLowerCase();
        if (!e || own.has(e) || toEmails.has(e) || seen.has(e)) return false;
        seen.add(e);
        return true;
      },
    );
    cc = rest.join(", ") || undefined;
  }
  return {
    to,
    cc,
    subject: reSubject(msg.subject),
    threadId: msg.threadId,
    inReplyTo: msg.rfc822MsgId || undefined,
    references: replyReferences(msg),
    // 원본 HTML 보존 — 없으면 평문을 HTML로 감싸 인용
    quoteHtml: directMessageHtml(msg),
    quoteFrom: msg.from,
    quoteDate: msg.date,
  };
}

// 대화 안에서 각 메일이 "무엇에 대한 답장인지"를 In-Reply-To/References로 이어
// 깊이를 매긴다. 목록이 시간순 평면으로만 깔리면 열 번 오간 대화의 갈래가 안 보인다.
export function replyDepths(msgs: MessageFull[]): Map<string, number> {
  const strip = (s: string) => s.trim().replace(/^<|>$/g, "");
  const byMsgId = new Map<string, MessageFull>();
  for (const m of msgs) {
    const key = strip(m.rfc822MsgId ?? "");
    if (key) byMsgId.set(key, m);
  }
  const parentOf = (m: MessageFull): MessageFull | undefined => {
    const direct = strip(m.inReplyTo ?? "");
    const refs = (m.references ?? "").trim().split(/\s+/).filter(Boolean);
    const last = refs.length ? strip(refs[refs.length - 1]) : "";
    const parent = byMsgId.get(direct) ?? (last ? byMsgId.get(last) : undefined);
    return parent && parent.id !== m.id ? parent : undefined;
  };
  const out = new Map<string, number>();
  for (const m of msgs) {
    let depth = 0;
    // 순환 참조(잘못된 헤더)에도 멈추도록 방문 집합으로 잠근다.
    const seen = new Set<string>([m.id]);
    for (let p = parentOf(m); p && !seen.has(p.id); p = parentOf(p)) {
      seen.add(p.id);
      depth++;
      if (depth >= 8) break; // 들여쓰기는 8단계면 충분 — 그 이상은 화면만 좁아진다
    }
    out.set(m.id, depth);
  }
  return out;
}

export const ThreadMessage = memo(function ThreadMessage({
  m,
  depth,
  index,
  total,
  collapsed,
  onToggle,
  guard,
  onComposeTo,
}: {
  m: MessageFull;
  depth: number;
  index: number;
  total: number;
  collapsed: boolean;
  onToggle: (id: string) => void;
  guard: (fn: () => Promise<void>) => Promise<void>;
  onComposeTo: (email: string) => void;
}) {
  // Inline (cid:) image parts → attachment URLs for the HTML body.
  const cidUrls = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of m.attachments) {
      if (a.contentId) map.set(a.contentId, api.attachmentUrl(m.id, a.id, a.filename));
    }
    return map;
  }, [m]);
  // 첨부 → Drive 저장 진행/결과 표시 (메시지 단위).
  const [driveMsg, setDriveMsg] = useState<string | null>(null);
  const saveToDrive = (a: {
    id: string;
    filename: string;
    mimeType: string;
  }) => {
    setDriveMsg(`Drive에 저장 중: ${a.filename}…`);
    void guard(async () => {
      try {
        await api.attachmentToDrive(m.id, a.id, a.filename, a.mimeType);
        setDriveMsg(`Drive에 저장됨: ${a.filename}`);
      } catch (e) {
        setDriveMsg(null); // 에러는 guard 배너로 — 낙관 문구는 지운다
        throw e;
      }
    });
  };
  const who = parseAddr(m.from);
  if (collapsed) {
    // 접힌 메일: 한 줄 요약만. 대화 열 통이 통째로 펼쳐지던 걸 막고,
    // 필요한 단계만 눌러서 연다.
    return (
      <div
        className="thread-msg collapsed"
        style={{ marginLeft: Math.min(depth, 8) * 16 }}
        data-depth={Math.min(depth, 8)}
      >
        <button type="button" className="thread-peek" onClick={() => onToggle(m.id)}>
          <span className="thread-peek-n">{index + 1}</span>
          <span className="thread-peek-who">{who.name || who.email}</span>
          <span className="thread-peek-snip">{m.snippet || "(내용 없음)"}</span>
          {m.attachments.some((a) => !a.contentId) && (
            <span className="thread-peek-att" title="첨부 있음">
              <AttachmentIcon />
            </span>
          )}
          <span className="thread-peek-when">{DATETIME_FMT.format(new Date(m.date))}</span>
          {m.unread && <span className="thread-peek-unread">●</span>}
        </button>
      </div>
    );
  }
  return (
    <div
      className="thread-msg"
      style={{ marginLeft: Math.min(depth, 8) * 16 }}
      data-depth={Math.min(depth, 8)}
    >
      <div className="reader-meta">
        <button
          type="button"
          className="thread-fold"
          onClick={() => onToggle(m.id)}
          title="이 메일 접기"
        >
          <span className="thread-peek-n">{index + 1}</span>
          ▾ 접기
        </button>
        {depth > 0 && (
          <span className="thread-depth" title={`답장 ${depth}단계`}>
            ↳ {depth}단계 답장
          </span>
        )}
        {index === total - 1 && total > 1 && <span className="thread-last">최신</span>}
        <div className="thread-from">
          <strong>{who.name}</strong>{" "}
          <button
            type="button"
            className="addr-link muted"
            title="이 주소로 새 메일"
            onClick={() => onComposeTo(who.email)}
          >
            &lt;{who.email}&gt;
          </button>
        </div>
        <div className="muted">받는사람: {m.to}</div>
        {m.cc && <div className="muted">참조: {m.cc}</div>}
        <div className="muted">{DATETIME_FMT.format(new Date(m.date))}</div>
        <span className={`thread-read-state ${m.unread ? "unread" : "read"}`}>
          {m.unread ? "● 안읽음" : "○ 읽음"}
        </span>
      </div>
      {m.attachments.some((a) => !a.contentId) && (
        <div className="attachments">
          {m.attachments
            .filter((a) => !a.contentId) // inline images render in the body
            .map((a) => (
              <span key={a.id} className="chip">
                <a
                  className="chip-link"
                  href={api.attachmentUrl(m.id, a.id, a.filename)}
                  onClick={(e) => {
                    e.preventDefault();
                    void guard(() => saveAttachment(m.id, a));
                  }}
                >
                  <AttachmentIcon />{a.filename} ({Math.round(a.size / 1024)}KB)
                </a>
                <button
                  type="button"
                  className="chip-x"
                  title="내 Drive에 저장"
                  onClick={() => saveToDrive(a)}
                >
                  <CloudIcon />
                </button>
              </span>
            ))}
          {driveMsg && <div className="muted">{driveMsg}</div>}
        </div>
      )}
      <div className="reader-body">
        {m.bodyHtml ? (
          <HtmlBody html={directMessageHtml(m)} id={m.id} cidUrls={cidUrls} onComposeTo={onComposeTo} />
        ) : (
          <TextBody text={directMessageText(m)} onComposeTo={onComposeTo} />
        )}
      </div>
    </div>
  );
});

export function TextBody({
  text,
  onComposeTo,
}: {
  text: string;
  onComposeTo: (email: string) => void;
}) {
  const parts = useMemo(() => linkifyParts(text), [text]);
  return (
    <pre className="text-body">
      {parts.map((p, i) =>
        p.href ? (
          p.href.startsWith("mailto:") ? (
            // 본문 이메일 주소 → 시스템 메일앱(iCloud 등)이 아니라 이 앱의 작성창
            <a
              key={i}
              href={p.href}
              onClick={(e) => {
                e.preventDefault();
                onComposeTo(p.href!.slice("mailto:".length));
              }}
            >
              {p.text}
            </a>
          ) : (
            <a key={i} href={p.href} target="_blank" rel="noopener noreferrer">
              {p.text}
            </a>
          )
        ) : (
          p.text
        ),
      )}
    </pre>
  );
}

// Renders email HTML in a sandboxed iframe and auto-sizes it to its content.
// allow-same-origin (WITHOUT allow-scripts) keeps email JS disabled while letting
// the parent measure the document height; allow-popups makes links open in a new tab.
export function HtmlBody({
  html,
  id,
  cidUrls,
  onComposeTo,
}: {
  html: string;
  id: string;
  cidUrls?: Map<string, string>;
  onComposeTo: (email: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  // 부모가 onLoad에서 iframe 문서에 click 리스너를 단다 — 최신 콜백을 ref로
  // 잡아 stale 클로저를 피한다.
  const composeRef = useRef(onComposeTo);
  composeRef.current = onComposeTo;
  // DOMParser full-parse is not free on big newsletters — don't redo it when
  // unrelated parent state (star toggle etc.) re-renders this component.
  const prepared = useMemo(() => prepareEmailHtml(html, undefined, cidUrls), [html, cidUrls]);
  // 어느 단계가 펼쳐져 있는지 — 네비게이터 칩 표시에 쓴다.
  const [openStages, setOpenStages] = useState<Set<number>>(new Set());

  const resize = useCallback(() => {
    const f = ref.current;
    const doc = f?.contentDocument;
    if (!f || !doc) return;
    // scrollHeight는 현재 뷰포트(=iframe 높이)보다 작아지지 않아 인용 접기로
    // 본문이 줄어도 높이가 따라 줄지 않는다 — 측정 전에 리셋한다. 두 스타일
    // 쓰기와 측정이 같은 태스크 안이라 중간 페인트(깜빡임)는 없다.
    const prev = f.style.height;
    f.style.height = "8px";
    const h = Math.max(
      doc.body?.scrollHeight ?? 0,
      doc.documentElement?.scrollHeight ?? 0,
    );
    f.style.height = h ? `${h + 8}px` : prev;
  }, []);

  // 인용 단계 열기/닫기. iframe은 same-origin이라 부모가 직접 open을 만진다
  // (프레임 안에는 스크립트가 없다).
  const syncOpen = useCallback(() => {
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    const next = new Set<number>();
    doc.querySelectorAll("details.qf[open]").forEach((d) => {
      const n = Number(d.id.replace("qstage-", ""));
      if (n) next.add(n);
    });
    setOpenStages(next);
  }, []);
  const applyStage = useCallback(
    (target: number | "all" | "none") => {
      const doc = ref.current?.contentDocument;
      if (!doc) return;
      if (target === "all" || target === "none") {
        doc.querySelectorAll("details.qf").forEach((d) => {
          (d as HTMLDetailsElement).open = target === "all";
        });
        return;
      }
      const el = doc.getElementById(`qstage-${target}`);
      if (!el) return;
      // 조상 단계까지 펴야 실제로 화면에 나온다.
      for (let p: HTMLElement | null = el; p; p = p.parentElement) {
        if (p.tagName === "DETAILS") (p as HTMLDetailsElement).open = true;
      }
      // 높이가 늘어난 뒤에 맞춰야 엉뚱한 위치로 튀지 않는다. same-origin
      // iframe의 scrollIntoView는 부모 스크롤러까지 함께 움직인다.
      resize();
      requestAnimationFrame(() => {
        resize();
        el.scrollIntoView({ block: "start" });
      });
    },
    [resize],
  );

  const onLoad = useCallback(() => {
    resize();
    const doc = ref.current?.contentDocument;
    if (!doc) return;
    doc.querySelectorAll("img").forEach((img) => {
      if (!img.complete) img.addEventListener("load", resize, { once: true });
    });
    setTimeout(resize, 400);
    setTimeout(resize, 1200);
    syncOpen();
    // 인용 접기(<details>) 토글 시 본문 높이가 바뀐다 — toggle은 버블링하지
    // 않으므로 캡처 단계에서 받아 재계산.
    doc.addEventListener(
      "toggle",
      () => {
        resize();
        syncOpen();
      },
      true,
    );
    // Handle only mailto/# clicks here. http(s) links are left to the
    // browser's NATIVE anchor navigation (prepareEmailHtml guarantees
    // target=_blank + rel on every anchor): real link clicks are exempt from
    // popup blocking, whereas window.open() from this handler is silently
    // blocked by managed/strict-policy browsers (corporate Chrome).
    doc.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const a = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      const href = a.getAttribute("href") || "";
      if (/^mailto:/i.test(href)) {
        // 시스템 메일앱(iCloud 등) 대신 이 앱의 작성창을 연다.
        e.preventDefault();
        let addr = href.slice(href.indexOf(":") + 1).split("?")[0];
        try {
          addr = decodeURIComponent(addr);
        } catch {
          // 잘못된 % 이스케이프(스팸 등): 원본 그대로 사용
        }
        composeRef.current(addr);
      } else if (href.startsWith("#")) {
        // In-document anchor (newsletter TOC etc.): scroll within the
        // auto-sized frame — the browser scrolls the parent page to match.
        e.preventDefault();
        let name = href.slice(1);
        try {
          name = decodeURIComponent(name);
        } catch {
          // malformed % escape ("#50%-off"): fall back to the raw fragment
        }
        if (!name) return;
        const el =
          doc.getElementById(name) ??
          doc.querySelector(`a[name="${CSS.escape(name)}"]`);
        // Instant scroll: smooth scrollIntoView does not reliably propagate
        // from the same-origin iframe to the parent scroller in Chromium.
        el?.scrollIntoView({ block: "start" });
      }
    });
  }, [resize, syncOpen]);

  return (
    <>
      {prepared.stages.length > 0 && (
        // 전달·답장으로 겹겹이 쌓인 히스토리를 단계 목록으로 노출한다.
        // 본문은 기본으로 접혀 있고, 여기서 원하는 단계만 열어 들어간다.
        <div className="qchain">
          <div className="qchain-head">
            <span className="qchain-title">
              🧾 인용·전달 히스토리 <b>{prepared.stages.length}단계</b>
            </span>
            <span className="qchain-sp" />
            <button type="button" className="btn sm" onClick={() => applyStage("all")}>
              모두 펼치기
            </button>
            <button type="button" className="btn sm" onClick={() => applyStage("none")}>
              모두 접기
            </button>
          </div>
          <div className="qchain-steps">
            {prepared.stages.map((s) => (
              <button
                key={s.n}
                type="button"
                className={`qchain-step${openStages.has(s.n) ? " on" : ""}`}
                style={{ marginLeft: Math.min(s.depth, 5) * 14 }}
                onClick={() => applyStage(s.n)}
                title={[s.who, s.when, s.subject].filter(Boolean).join(" · ") || "이전 대화"}
              >
                <span className="qchain-n">{s.n}</span>
                <span className="qchain-who">{s.who || "이전 대화"}</span>
                {s.when && <span className="qchain-when">{s.when}</span>}
                {s.subject && <span className="qchain-sub">{s.subject}</span>}
              </button>
            ))}
          </div>
        </div>
      )}
      <iframe
        ref={ref}
        title={`message-${id}`}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={prepared.html}
        className="html-frame"
        onLoad={onLoad}
      />
    </>
  );
}
