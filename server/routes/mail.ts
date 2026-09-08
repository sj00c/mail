import { Hono } from "hono";
import { apiErrorStatus, httpStatusOf, publicApiError } from "../apiErrors.ts";
import {
  createDraft,
  deleteDraft,
  findDraftByMessageId,
  getAccountSettings,
  getAttachment,
  getGmailSignature,
  updateDraft,
  getThread,
  getProfile,
  listLabels,
  listMessages,
  modifyMessage,
  batchModifyMessages,
  batchTrashMessages,
  prepareBulkAllMessages,
  confirmBulkAllMessages,
  sendMessage,
  trashMessage,
} from "../gmail.ts";
import { uploadFile } from "../drive.ts";
import { finiteOr } from "./params.ts";

export function createMessageListApi(
  listMessagesImpl: typeof listMessages = listMessages,
): Hono {
  const messages = new Hono();

  messages.get("/", async (c) => {
    const q = c.req.query("q") || undefined;
    const label = c.req.query("label") || undefined;
    const pageToken = c.req.query("pageToken") || undefined;
    const max = finiteOr(c.req.query("maxResults"), "maxResults");
    if (!max.ok) return c.json({ error: max.error }, 400);
    if (
      max.value !== undefined &&
      (!Number.isInteger(max.value) || max.value < 1 || max.value > 500)
    ) {
      return c.json(
        { error: "maxResults must be an integer from 1 to 500" },
        400,
      );
    }
    return c.json(
      await listMessagesImpl({
        q,
        labelIds: label ? [label] : undefined,
        pageToken,
        maxResults: max.value,
      }),
    );
  });
  messages.onError((e, c) => {
    const status = apiErrorStatus(e);
    console.error("[api/messages]", e);
    return c.json({ error: publicApiError(e) }, status);
  });

  return messages;
}

export function createMailRoutes(): Hono {
  const mail = new Hono();

  mail.get("/profile", async (c) => c.json(await getProfile()));

  mail.get("/labels", async (c) => c.json(await listLabels()));

  mail.route("/messages", createMessageListApi());

  mail.get("/threads/:id", async (c) =>
    c.json(await getThread(c.req.param("id"))),
  );

  mail.get("/messages/:id/attachments/:aid", async (c) => {
    const buf = await getAttachment(c.req.param("id"), c.req.param("aid"));
    const filename = c.req.query("filename") || "attachment";
    // Header-safe ASCII fallback + RFC 5987 encoded full name (Korean filenames etc.).
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    const encoded = encodeURIComponent(filename).replace(
      /['()*]/g,
      (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      },
    });
  });
  // 첨부파일을 내 Drive에 저장 (Gmail → Drive, 브라우저 왕복 없이 서버에서 직행).
  mail.post("/messages/:id/attachments/:aid/drive", async (c) => {
    const { filename, mimeType } = (await c.req.json()) as {
      filename?: string;
      mimeType?: string;
    };
    if (!filename) return c.json({ error: "filename required" }, 400);
    const buf = await getAttachment(c.req.param("id"), c.req.param("aid"));
    const file = await uploadFile({
      name: filename,
      mimeType: mimeType || "application/octet-stream",
      data: buf.toString("base64"),
    });
    return c.json(file);
  });

  mail.post("/messages/:id/modify", async (c) => {
    const body = await c.req.json<{ add?: string[]; remove?: string[] }>();
    await modifyMessage(c.req.param("id"), body);
    return c.json({ ok: true });
  });

  mail.post("/messages/:id/trash", async (c) => {
    await trashMessage(c.req.param("id"));
    return c.json({ ok: true });
  });

  // 일괄 처리(목록 체크박스 선택). ids는 클라이언트가 보낸 메시지 id 배열.
  mail.post("/messages/batchModify", async (c) => {
    const body = await c.req.json<{
      ids?: string[];
      add?: string[];
      remove?: string[];
    }>();
    await batchModifyMessages(body.ids ?? [], {
      add: body.add,
      remove: body.remove,
    });
    return c.json({ ok: true });
  });

  mail.post("/messages/batchTrash", async (c) => {
    const body = await c.req.json<{ ids?: string[] }>();
    await batchTrashMessages(body.ids ?? []);
    return c.json({ ok: true });
  });

  mail.post("/messages/bulkAll/prepare", async (c) => {
    const body = await c.req.json<{
      q?: string;
      label?: string;
      action?: "read" | "unread" | "trash";
    }>();
    if (!body.action || !["read", "unread", "trash"].includes(body.action)) {
      return c.json({ error: "action must be read, unread, or trash" }, 400);
    }
    return c.json(
      await prepareBulkAllMessages({
        q: body.q?.trim() || undefined,
        labelIds: body.label ? [body.label] : undefined,
        action: body.action,
      }),
    );
  });

  mail.post("/messages/bulkAll/confirm", async (c) => {
    const body = await c.req.json<{ operationId?: string }>();
    if (!body.operationId)
      return c.json({ error: "operationId required" }, 400);
    return c.json(await confirmBulkAllMessages(body.operationId));
  });

  mail.post("/send", async (c) => {
    const body = await c.req.json();
    const res = await sendMessage(body);
    return c.json(res);
  });

  mail.post("/draft", async (c) => {
    const body = await c.req.json();
    return c.json(await createDraft(body));
  });

  mail.get("/drafts/by-message/:id", async (c) => {
    const found = await findDraftByMessageId(c.req.param("id"));
    if (!found) return c.json({ error: "DRAFT_NOT_FOUND" }, 404);
    return c.json(found);
  });

  mail.put("/drafts/:id", async (c) => {
    const body = await c.req.json();
    try {
      return c.json(await updateDraft(c.req.param("id"), body));
    } catch (e) {
      // Draft deleted/sent elsewhere (Gmail web) while our editor was open —
      // give the client a typed 404 so it can fall back to creating a new draft.
      if (httpStatusOf(e) === 404)
        return c.json({ error: "DRAFT_NOT_FOUND" }, 404);
      throw e;
    }
  });

  mail.post("/drafts/:id/delete", async (c) => {
    await deleteDraft(c.req.param("id"));
    return c.json({ ok: true });
  });

  mail.get("/signature", async (c) => c.json(await getGmailSignature()));

  mail.get("/settings/account", async (c) =>
    c.json(await getAccountSettings()),
  );

  return mail;
}
