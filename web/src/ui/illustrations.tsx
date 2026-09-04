// 빈 상태 일러스트 — 아이콘과 같은 선 굵기의 선화. 색은 CSS(.empty-art)가 준다:
// .art-soft 은 은은한 강조색 면, .art-line 은 currentColor 선, .art-spark 는 반짝이.
type Kind = "mail" | "calendar" | "folder";

const SPARKS = (
  <>
    <circle className="art-spark" cx="18" cy="22" r="2" />
    <path className="art-spark" d="M78 14l1.6 3.4L83 19l-3.4 1.6L78 24l-1.6-3.4L73 19l3.4-1.6Z" />
    <circle className="art-spark" cx="82" cy="70" r="1.6" />
  </>
);

const ART: Record<Kind, JSX.Element> = {
  mail: (
    <>
      <path className="art-soft" d="M20 36 48 18l28 18v32a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4Z" />
      <path className="art-line" d="M20 36 48 18l28 18v32a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4Z" />
      <path className="art-line" d="m20 36 28 20 28-20M20 68l20-16M76 68 56 52" />
      <path className="art-line" d="m40 40 6 6 12-12" />
      {SPARKS}
    </>
  ),
  calendar: (
    <>
      <rect className="art-soft" x="20" y="24" width="56" height="50" rx="7" />
      <rect className="art-line" x="20" y="24" width="56" height="50" rx="7" />
      <path className="art-line" d="M20 38h56M34 18v10M62 18v10" />
      <path className="art-line" d="M31 50h6M45 50h6M59 50h6M31 62h6M45 62h6" />
      {SPARKS}
    </>
  ),
  folder: (
    <>
      <path className="art-soft" d="M18 30a5 5 0 0 1 5-5h16l6 7h28a5 5 0 0 1 5 5v31a5 5 0 0 1-5 5H23a5 5 0 0 1-5-5Z" />
      <path className="art-line" d="M18 30a5 5 0 0 1 5-5h16l6 7h28a5 5 0 0 1 5 5v31a5 5 0 0 1-5 5H23a5 5 0 0 1-5-5Z" />
      <path className="art-line" d="M18 42h60" />
      {SPARKS}
    </>
  ),
};

export function EmptyArt({ kind }: { kind: Kind }) {
  return (
    <svg className="empty-art" viewBox="0 0 96 96" aria-hidden="true">
      {ART[kind]}
    </svg>
  );
}
