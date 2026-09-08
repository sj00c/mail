import { api, type Contact } from "../api.ts";

// 연락처는 작성창/일정 참석자 입력이 공유하는 모듈 캐시. 실패는 조용히
// 빈 목록으로 끝내고 promise를 비워 다음 화면 오픈 때 재시도한다.
let contactsPromise: Promise<Contact[]> | null = null;

export function loadContactsOnce(): Promise<Contact[]> {
  contactsPromise ??= api.contacts().catch(() => {
    contactsPromise = null;
    return [];
  });
  return contactsPromise;
}
