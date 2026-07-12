// git 실행 규약 — 단일진실 (플랜 W8).
// 이 모듈 밖에서 git 스폰 인자·env 를 조립하지 않는다. 규약:
//   - env 고정: LC_ALL/LANG=C — 비영어 locale 에서 출력이 흔들리는 파싱 버그를 원천 차단.
//     읽기에는 GIT_OPTIONAL_LOCKS=0 — 조회가 index 잠금을 만들지 않는다(감시 이벤트 오염 0).
//   - 기계 파싱은 porcelain·-z 만. stderr 문구 파싱 금지(원문은 에러 메시지로만 전달).
//   - ref 는 화이트리스트 + --end-of-options, 경로는 "--" 뒤 — 옵션 주입 차단.
//   - 쓰기 timeout 180s(클라우드 placeholder stall 대비), 읽기 30s.

export const READ_ENV = Object.freeze({ LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" });
export const WRITE_ENV = Object.freeze({ LC_ALL: "C", LANG: "C" });
export const READ_TIMEOUT_MS = 30_000;
export const WRITE_TIMEOUT_MS = 180_000;

export function envFor(kind) {
  return kind === "write" ? { ...WRITE_ENV } : { ...READ_ENV };
}

export function timeoutFor(kind) {
  return kind === "write" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
}

// 커밋 참조 화이트리스트: hex 4~40 / HEAD / HEAD^ / HEAD~N. 그 외 전부 거부 —
// 특히 "-" 시작(옵션 주입)과 자유 문자열. 레거시 코어와 같은 계약.
export function sanitizeCommit(c) {
  if (typeof c !== "string") return false;
  if (c.length >= 4 && c.length <= 40 && /^[0-9a-fA-F]+$/.test(c)) return true;
  if (c === "HEAD" || c === "HEAD^") return true;
  const n = c.startsWith("HEAD~") ? c.slice(5) : null;
  return n !== null && n.length > 0 && /^[0-9]+$/.test(n);
}

// 브랜치명 규칙 — git-check-ref-format 의 보수 부분집합. 옵션 주입("-" 시작)·
// ".." 탈출·".lock" 접미·공백·말미 "/" 차단.
export function validBranchName(b) {
  if (typeof b !== "string" || b.length === 0) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b)) return false;
  if (b.includes("..") || b.endsWith(".lock") || b.endsWith("/") || b.endsWith(".")) return false;
  return true;
}

// ref 규칙 — 브랜치명이거나 커밋 참조. diff·merge 처럼 "브랜치든 커밋이든 받는" 표면의 게이트.
// ".." 는 range 문법이라 여기서 막힌다(삼점 range 는 우리가 조립한다 — 입력이 가져오지 않는다).
export function validRef(r) {
  return validBranchName(r) || sanitizeCommit(r);
}

// clone url → 대상 디렉토리명. 슬러그+점만 허용(탈출·주입·"-" 시작 차단), 아니면 null —
// 호출자는 null 이면 거부한다(repo 명 검증 계약).
export function repoDirFromUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.replace(/\/+$/, "");
  let tail;
  if (trimmed.includes("://")) {
    // 스킴 URL — 호스트 뒤에 repo 경로 세그먼트가 실존해야 한다(호스트만은 거부).
    const segs = trimmed.slice(trimmed.indexOf("://") + 3).split("/");
    if (segs.length < 2) return null;
    tail = segs[segs.length - 1];
  } else if (trimmed.includes(":")) {
    // scp 형(git@host:path) — ":" 뒤 경로의 마지막 세그먼트.
    const segs = trimmed.slice(trimmed.lastIndexOf(":") + 1).split("/");
    tail = segs[segs.length - 1];
  } else {
    // 로컬 경로 — 마지막 세그먼트(단일 세그먼트는 모호 — 거부).
    const segs = trimmed.split("/");
    if (segs.length < 2) return null;
    tail = segs[segs.length - 1];
  }
  const name = tail.endsWith(".git") ? tail.slice(0, -4) : tail;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return name;
}

// stderr 문구 파싱 금지의 유일한 재가 예외 — root tri-state 의 not-repo 판별.
// git 은 "저장소 아님"과 "그 외 치명 오류"를 같은 exit 128 로 낸다. env 고정(LC_ALL=C)이
// 이 문구를 판(버전) 간 안정 문자열로 만들며, 사용 지점은 이 정규식 하나로 제한한다.
export const NOT_REPO_RE = /not a git repository/i;

// 경로가 repo 루트 안에 있는지 증명(문자열 정규화 기준) — discard 의 untracked 삭제 등
// 파괴 작업 전 필수 검증. 절대경로·".." 탈출은 false.
export function insideRepo(root, rel) {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.startsWith("/") || rel.startsWith("-")) return false;
  const parts = rel.split("/");
  if (parts.includes("..") || parts.includes("")) return false;
  return true;
}
