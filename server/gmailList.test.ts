import { describe, expect, it, vi } from "vitest";
import { GmailBatchPartError } from "./gmailBatch.ts";
import {
  createMessageListTransport,
  listMessagesWithTransport,
  type MessageListTransport,
} from "./gmail.ts";

const boundary = "fixture";

function multipart(parts: Array<{ index: number; status: number; body?: unknown }>) {
  return parts
    .map(({ index, status, body }) => [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <response-mail-item-${index}>`,
      "",
      `HTTP/1.1 ${status} Status`,
      "Content-Type: application/json",
      "",
      JSON.stringify(body ?? {}),
    ].join("\r\n"))
    .concat(`--${boundary}--`)
    .join("\r\n");
}

function message(id: string) {
  return {
    id,
    threadId: `thread-${id}`,
    internalDate: "0",
    labelIds: ["INBOX"],
    payload: { headers: [{ name: "From", value: "sender@example.test" }] },
  };
}

function transportFor(ids: string[], statuses: number[] = []): MessageListTransport & {
  batchCalls: number;
  refreshCalls: number;
  retryDelays: number[];
} {
  let batchCalls = 0;
  let refreshCalls = 0;
  const retryDelays: number[] = [];
  return {
    get batchCalls() { return batchCalls; },
    get refreshCalls() { return refreshCalls; },
    retryDelays,
    async list() { return { messages: ids.map((id) => ({ id })), nextPageToken: "next", resultSizeEstimate: ids.length }; },
    async batch(body) {
      batchCalls++;
      const chunkIds = [...body.matchAll(/messages\/([^?]+)\?/g)].map((match) => decodeURIComponent(match[1]));
      return {
        contentType: `multipart/mixed; boundary="${boundary}"`,
        body: multipart(chunkIds.map((id, index) => ({
          index,
          status: statuses[index] ?? 200,
          body: statuses[index] === 404 ? {} : message(id),
        })).reverse()),
      };
    },
    async refresh() { refreshCalls++; },
    async waitBeforeRetry(milliseconds) { retryDelays.push(milliseconds); },
  };
}
  it("asks the production Gaxios adapter for text and parses that body", async () => {
    const request = vi.fn(async () => ({
      headers: { "content-type": `multipart/mixed; boundary="${boundary}"` },
      body: "ignored",
      data: multipart([{ index: 0, status: 200, body: message("adapter") }]),
    }));
    const transport = createMessageListTransport({
      request,
      async refreshAccessToken() {},
    });
    transport.list = async () => ({ messages: [{ id: "adapter" }], resultSizeEstimate: 1 });

    await expect(listMessagesWithTransport({}, transport)).resolves.toMatchObject({
      messages: [{ id: "adapter" }],
    });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({
      responseType: "text",
    }));
  });

describe("listMessages batch transport", () => {
  it.each([[0, 0], [1, 1], [25, 1], [50, 1], [51, 2], [101, 3]])(
    "uses no more than fifty message GETs per batch for %i refs",
    async (count, expectedBatches) => {
      const transport = transportFor(Array.from({ length: count }, (_, i) => `m${i}`));
      const result = await listMessagesWithTransport({}, transport);
      expect(transport.batchCalls).toBe(expectedBatches);
      expect(result.messages.map((item) => item.id)).toEqual(Array.from({ length: count }, (_, i) => `m${i}`));
      expect(result.nextPageToken).toBe("next");
    },
  );

  it("omits only embedded 404s and preserves list order", async () => {
    const transport = transportFor(["first", "gone", "third"], [200, 404, 200]);
    const result = await listMessagesWithTransport({}, transport);
    expect(result.messages.map((item) => item.id)).toEqual(["first", "third"]);
  });

  it("refreshes and retries a 401/403 batch exactly once", async () => {
    let calls = 0;
    const transport = transportFor(["one"]);
    const batch = transport.batch.bind(transport);
    transport.batch = async (body, sentBoundary) => {
      calls++;
      if (calls === 1) return { contentType: `multipart/mixed; boundary=${boundary}`, body: multipart([{ index: 0, status: 401 }]) };
      return batch(body, sentBoundary);
    };
    await expect(listMessagesWithTransport({}, transport)).resolves.toMatchObject({ messages: [{ id: "one" }] });
    expect(transport.refreshCalls).toBe(1);
    expect(calls).toBe(2);
  });

  it.each([429, 500])("retries embedded %i failures with exponential backoff", async (status) => {
    let calls = 0;
    const transport = transportFor(["one"]);
    const batch = transport.batch.bind(transport);
    transport.batch = async (body, sentBoundary) => {
      calls++;
      if (calls <= 2) {
        return {
          contentType: `multipart/mixed; boundary=${boundary}`,
          body: multipart([{ index: 0, status }]),
        };
      }
      return batch(body, sentBoundary);
    };

    await expect(listMessagesWithTransport({}, transport)).resolves.toMatchObject({
      messages: [{ id: "one" }],
    });
    expect(transport.retryDelays).toEqual([1_000, 2_000]);
    expect(calls).toBe(3);
  });

  it("retries an outer 429 response before parsing the batch", async () => {
    let calls = 0;
    const transport = transportFor(["one"]);
    const batch = transport.batch.bind(transport);
    transport.batch = async (body, sentBoundary) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return batch(body, sentBoundary);
    };

    await expect(listMessagesWithTransport({}, transport)).resolves.toMatchObject({
      messages: [{ id: "one" }],
    });
    expect(transport.retryDelays).toEqual([1_000]);
    expect(calls).toBe(2);
  });

  it("retries only rate-limited batch parts instead of repeating successful requests", async () => {
    const requestedIds: string[][] = [];
    const transport = transportFor(["ready", "limited"]);
    transport.batch = async (body) => {
      const ids = [...body.matchAll(/messages\/([^?]+)\?/g)]
        .map((match) => decodeURIComponent(match[1]));
      requestedIds.push(ids);
      return {
        contentType: `multipart/mixed; boundary=${boundary}`,
        body: multipart(ids.map((id, index) => ({
          index,
          status: id === "limited" && requestedIds.length === 1 ? 429 : 200,
          body: message(id),
        }))),
      };
    };

    await expect(listMessagesWithTransport({}, transport)).resolves.toMatchObject({
      messages: [{ id: "ready" }, { id: "limited" }],
    });
    expect(requestedIds).toEqual([["ready", "limited"], ["limited"]]);
    expect(transport.retryDelays).toEqual([1_000]);
  });
  it("processes chunks sequentially and allows one refresh/retry only for an affected chunk", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `m${index}`);
    const requests: string[] = [];
    let batches = 0;
    let refreshes = 0;
    const transport: MessageListTransport = {
      async list() {
        return { messages: ids.map((id) => ({ id })), resultSizeEstimate: ids.length };
      },
      async batch(body) {
        requests.push(body);
        const chunk = [...body.matchAll(/messages\/([^?]+)\?/g)]
          .map((match) => decodeURIComponent(match[1]));
        const status = batches++ === 1 ? 403 : 200;
        return {
          contentType: `multipart/mixed; boundary=${boundary}`,
          body: multipart(chunk.map((id, index) => ({
            index,
            status,
            body: status === 200 ? message(id) : {
              error: { status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] },
            },
          }))),
        };
      },
      async refresh() {
        refreshes++;
      },
    };

    await expect(listMessagesWithTransport({}, transport)).resolves.toMatchObject({
      messages: ids.map((id) => ({ id })),
    });
    expect(refreshes).toBe(1);
    expect(requests).toHaveLength(4); // 50, then retry 50, then 50, then 1
    expect(requests.map((request) => [...request.matchAll(/\r\nGET /g)]).map((gets) => gets.length))
      .toEqual([50, 50, 50, 1]);
  });

  it("uses one refresh across auth-failing chunks and fails before a later chunk", async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `private-${index}`);
    let batches = 0;
    let refreshes = 0;
    const transport: MessageListTransport = {
      async list() {
        return { messages: ids.map((id) => ({ id })), resultSizeEstimate: ids.length };
      },
      async batch(body) {
        const chunk = [...body.matchAll(/messages\/([^?]+)\?/g)]
          .map((match) => decodeURIComponent(match[1]));
        const status = batches++ === 0 ? 401 : chunk[0] === "private-50" ? 403 : 200;
        return {
          contentType: `multipart/mixed; boundary=${boundary}`,
          body: multipart(chunk.map((id, index) => ({
            index,
            status,
            body: status === 200 ? message(id) : {
              error: { status: "PERMISSION_DENIED", errors: [{ reason: "insufficientPermissions" }] },
            },
          }))),
        };
      },
      async refresh() {
        refreshes++;
      },
    };

    await expect(listMessagesWithTransport({}, transport)).rejects.toMatchObject({
      name: "GmailBatchPartError",
      status: 403,
    } satisfies Partial<GmailBatchPartError>);
    expect(refreshes).toBe(1);
    expect(batches).toBe(3); // first chunk, its retry, then second chunk; never third
  });

  it("keeps refresh budgets isolated across concurrent operations while sharing one refresh", async () => {
    let listCall = 0;
    let refreshInvocations = 0;
    let actualRefreshes = 0;
    let refreshPromise: Promise<void> | undefined;
    const attempts = new Map<string, number>();
    const transport: MessageListTransport = {
      async list() {
        const id = `operation-${listCall++}`;
        return { messages: [{ id }], resultSizeEstimate: 1 };
      },
      async batch(body) {
        const id = decodeURIComponent([...body.matchAll(/messages\/([^?]+)\?/g)][0][1]);
        const attempt = attempts.get(id) ?? 0;
        attempts.set(id, attempt + 1);
        const status = attempt === 0 ? 401 : 200;
        return {
          contentType: `multipart/mixed; boundary=${boundary}`,
          body: multipart([{ index: 0, status, body: status === 200 ? message(id) : {} }]),
        };
      },
      async refresh() {
        refreshInvocations++;
        refreshPromise ??= Promise.resolve().then(() => {
          actualRefreshes++;
        });
        await refreshPromise;
      },
    };

    const [first, second] = await Promise.all([
      listMessagesWithTransport({}, transport),
      listMessagesWithTransport({}, transport),
    ]);
    expect(first.messages.map((item) => item.id)).toEqual(["operation-0"]);
    expect(second.messages.map((item) => item.id)).toEqual(["operation-1"]);
    expect(refreshInvocations).toBe(2);
    expect(actualRefreshes).toBe(1);
  });
  it("fails closed after the single retry and does not send later chunks", async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `private-${index}`);
    let batches = 0;
    let refreshes = 0;
    const transport: MessageListTransport = {
      async list() {
        return { messages: ids.map((id) => ({ id })), resultSizeEstimate: ids.length };
      },
      async batch(body) {
        batches++;
        const chunk = [...body.matchAll(/messages\/([^?]+)\?/g)]
          .map((match) => decodeURIComponent(match[1]));
        return {
          contentType: `multipart/mixed; boundary=${boundary}`,
          body: multipart(chunk.map((_, index) => ({
            index,
            status: 401,
            body: { error: { message: "private token and message content" } },
          }))),
        };
      },
      async refresh() {
        refreshes++;
        throw Object.assign(new Error("refresh invalid_grant"), {
          response: { data: { error: "invalid_grant" } },
        });
      },
    };

    await expect(listMessagesWithTransport({}, transport)).rejects.toThrow("invalid_grant");
    expect(refreshes).toBe(1);
    expect(batches).toBe(1);
  });

  it.each([401, 403, 429, 500])("keeps embedded %i failures machine-classified and redacted", async (status) => {
    const transport = transportFor(["private-message"], [status]);
    await expect(listMessagesWithTransport({}, transport)).rejects.toMatchObject({
      name: "GmailBatchPartError",
      status,
    } satisfies Partial<GmailBatchPartError>);
    await expect(listMessagesWithTransport({}, transport)).rejects.not.toThrow("private-message");
  });
});
