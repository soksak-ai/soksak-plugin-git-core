// 삼점(base...target) 변경 목록 파서 — 계약 diff.files 의 순수부(soksak-git-spec@1 §7.3).
// 두 출력을 합친다: --name-status(무엇이 어떻게 바뀌었나) + --numstat(몇 줄).
// 삼점인 이유: base..target(이점)은 base 가 그동안 쌓은 커밋까지 이 브랜치가 한 일로 보고한다.

const STATUS = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged",
};

// `git diff --name-status` → [{status, path, oldPath?}]. 이름변경·복사는 원본 경로를 싣는다.
export function parseNameStatus(stdout) {
  const out = [];
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const letter = (cols[0] || "")[0] || "";
    const status = STATUS[letter] ?? "modified";
    if ((letter === "R" || letter === "C") && cols.length >= 3) {
      out.push({ status, path: cols[2], oldPath: cols[1] });
    } else {
      out.push({ status, path: cols[cols.length - 1] });
    }
  }
  return out;
}

// `git diff --numstat` → Map(path → {added, deleted, binary}). 바이너리는 "-"/"-" 로 온다 —
// 0 줄 변경이 아니라 "셀 수 없음"이다(null + binary:true 로 사실대로 싣는다).
export function parseNumstat(stdout) {
  const map = new Map();
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 3) continue;
    const added = cols[0] === "-" ? null : Number(cols[0]);
    const deleted = cols[1] === "-" ? null : Number(cols[1]);
    let path = cols.slice(2).join("\t");
    if (path.includes(" => ")) {
      // 이름변경 표기: "{old => new}/x" 또는 "old => new" — 새 경로만 남긴다(name-status 와 키 정합).
      path = path.replace(/\{[^}]*? => ([^}]*?)\}/g, "$1").replace(/^.* => /, "");
    }
    map.set(path, { added, deleted, binary: added === null && deleted === null });
  }
  return map;
}

// 두 파싱을 계약 파일 목록으로 합친다. numstat 에 없는 파일도 목록에서 빠지지 않는다 —
// 상태(name-status)가 주(主)이고 줄 수는 부가 정보다.
export function mergeFileList(entries, counts) {
  return (entries ?? []).map((f) => {
    const n = counts?.get(f.path) ?? {};
    return {
      path: f.path,
      status: f.status,
      ...(f.oldPath ? { oldPath: f.oldPath } : {}),
      added: n.added ?? null,
      deleted: n.deleted ?? null,
      binary: n.binary === true,
    };
  });
}
