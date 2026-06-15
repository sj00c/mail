import { people as peopleApi, type people_v1 } from "@googleapis/people";
import { getAuthedClient } from "./auth.ts";

async function api(): Promise<people_v1.People> {
  const auth = await getAuthedClient();
  return peopleApi({ version: "v1", auth });
}

export type Contact = { name: string; email: string };

// 주소록은 자주 안 바뀌는데 작성창을 열 때마다 People API 두 번(연락처 +
// 자주 주고받은 주소)을 때릴 필요는 없다 — 메모리 캐시, 로그아웃 시 비움.
const TTL_MS = 10 * 60_000;
let cache: { items: Contact[]; at: number } | null = null;

/** Drop cached contacts (call on logout — account-scoped). */
export function clearContactsCache(): void {
  cache = null;
}

function collect(
  out: Map<string, Contact>,
  persons: people_v1.Schema$Person[] | undefined,
): void {
  for (const p of persons ?? []) {
    const name = p.names?.[0]?.displayName?.trim() ?? "";
    for (const e of p.emailAddresses ?? []) {
      const email = e.value?.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      const prev = out.get(key);
      // 같은 주소가 여러 번 나오면 이름 있는 항목을 우선한다.
      if (!prev || (!prev.name && name)) out.set(key, { name, email });
    }
  }
}

/** 내 연락처 + "자주 주고받은 주소"(otherContacts)를 이메일 기준으로 병합. */
export async function listContacts(): Promise<Contact[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.items;
  const p = await api();
  const out = new Map<string, Contact>();

  let pageToken: string | undefined;
  do {
    const res = await p.people.connections.list({
      resourceName: "people/me",
      personFields: "names,emailAddresses",
      pageSize: 1000,
      pageToken,
    });
    collect(out, res.data.connections);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  // otherContacts를 나중에 합쳐 정식 연락처의 이름이 우선되게 한다.
  pageToken = undefined;
  do {
    // 명시적 타입: list() 오버로드 선택이 pageToken을 거쳐 res 자신을 참조하는
    // 순환 추론(TS7022)에 빠진다.
    const res: { data: people_v1.Schema$ListOtherContactsResponse } =
      await p.otherContacts.list({
        readMask: "names,emailAddresses",
        pageSize: 1000,
        pageToken,
      });
    collect(out, res.data.otherContacts);
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  const items = [...out.values()].sort((a, b) =>
    (a.name || a.email).localeCompare(b.name || b.email, "ko"),
  );
  cache = { items, at: Date.now() };
  return items;
}
