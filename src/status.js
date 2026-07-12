// porcelain v2 --branch -z 파서 (L1 status 단일진실).
// 기계 파싱 규약: NUL 종결 레코드만 신뢰, stderr 문구 파싱 금지(convention.js).
// 레코드: "# ..."(브랜치 헤더) / "1 ..."(변경) / "2 ..."(이름변경·복사, -z 는 원본 경로가
// 다음 NUL 필드) / "u ..."(병합 충돌) / "? path"(미추적) / "! path"(무시).

// XY → 데코레이션 분류. 레거시 코어 classify_git(파일트리 데코)와 동등 우선순위 —
// 소비자(파일트리)가 상태 문자열을 그대로 이어받는다. u 레코드는 conflicted(신설 축).
export function classifyXY(x, y) {
  if (x === "?" || y === "?") return "untracked";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  if (x === "A" || y === "A") return "added";
  return "modified";
}

const DEFAULT_MAX_ENTRIES = 5000;

// parseStatusV2(stdout, {maxEntries}) → { branch, entries, truncated }
//   branch  = { oid?, head?, upstream?, ahead?, behind? }
//   entries = [{ path, x, y, status, origPath? }] — status ∈
//             untracked|ignored|conflicted|deleted|renamed|added|modified
export function parseStatusV2(stdout, opts = {}) {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const branch = {};
  const entries = [];
  let truncated = false;
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      const [key, ...rest] = rec.slice(2).split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") branch.oid = val;
      else if (key === "branch.head") branch.head = val;
      else if (key === "branch.upstream") branch.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const push = (entry) => {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push(entry);
    };
    const kind = rec[0];
    if (kind === "?" || kind === "!") {
      push({
        path: rec.slice(2),
        x: kind,
        y: kind,
        status: kind === "?" ? "untracked" : "ignored",
      });
      continue;
    }
    if (kind === "1") {
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      const path = f.slice(8).join(" ");
      push({ path, x: xy[0], y: xy[1], status: classifyXY(xy[0], xy[1]) });
      continue;
    }
    if (kind === "2") {
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      const path = f.slice(9).join(" ");
      const origPath = fields[++i] ?? ""; // -z: 원본 경로는 다음 NUL 필드
      push({ path, origPath, x: xy[0], y: xy[1], status: classifyXY(xy[0], xy[1]) });
      continue;
    }
    if (kind === "u") {
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      const path = f.slice(10).join(" ");
      push({ path, x: xy[0], y: xy[1], status: "conflicted" });
    }
    // 그 외 레코드 종류는 판올림 전까지 무시(전방 호환 — 실패 아님).
  }
  return { branch, entries, truncated };
}
