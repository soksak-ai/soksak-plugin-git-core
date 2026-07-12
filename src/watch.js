// L1 변경 감시 계획·분류 (git.changed 이벤트의 토대).
// 코어 fs.watch(비재귀·OS 네이티브·경로 refcount dedup)를 소비한다 — 폴링 0.
// 코어 fs-change 는 변경의 "부모 디렉토리"만 싣는다 → kind 는 디렉토리 단위:
//   <root>/.git            → "meta"(HEAD·index·MERGE_HEAD 등)
//   <root>/.git/refs/heads → "refs"(브랜치 팁)
// 파일명 단위 *.lock/FETCH_HEAD 필터는 코어 payload 가 파일명을 싣기 전까지 불가 —
// 트레일링 디바운스가 잠금 파일 생성·삭제의 연발을 1발로 합친다(잔여 항목: README).

export function watchDirs(root) {
  return [`${root}/.git`, `${root}/.git/refs/heads`];
}

export function classifyChange(root, dir) {
  if (dir === `${root}/.git`) return "meta";
  if (dir === `${root}/.git/refs/heads`) return "refs";
  return null;
}

// 트레일링 디바운스 — 윈도 내 kind 를 집합으로 모아 마지막에 1회 발화.
export function makeTrailingDebounce(ms, fire) {
  let timer = null;
  let kinds = new Set();
  return (kind) => {
    kinds.add(kind);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = kinds;
      kinds = new Set();
      timer = null;
      fire(batch);
    }, ms);
  };
}
