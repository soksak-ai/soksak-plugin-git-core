// L2 worktree — `git worktree list --porcelain -z` 파서.
// -z: 속성은 NUL 종결, 블록(워크트리 1개)은 빈 레코드(NUL NUL)로 끝난다.
export function parseWorktreeList(stdout) {
  const list = [];
  let cur = null;
  for (const rec of stdout.split("\0")) {
    if (rec === "") {
      if (cur) list.push(cur);
      cur = null;
      continue;
    }
    const sp = rec.indexOf(" ");
    const key = sp < 0 ? rec : rec.slice(0, sp);
    const val = sp < 0 ? undefined : rec.slice(sp + 1);
    if (key === "worktree") {
      if (cur) list.push(cur); // 방어 — 빈 레코드 없이 다음 블록이 오는 변형
      cur = { path: val ?? "" };
      continue;
    }
    if (!cur) continue;
    if (key === "HEAD") cur.head = val ?? "";
    else if (key === "branch") cur.branch = (val ?? "").replace(/^refs\/heads\//, "");
    else if (key === "detached") cur.detached = true;
    else if (key === "bare") cur.bare = true;
    else if (key === "locked") cur.locked = val ?? "";
    else if (key === "prunable") cur.prunable = val ?? "";
  }
  if (cur) list.push(cur);
  return list;
}
