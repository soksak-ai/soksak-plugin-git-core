// L1 status — porcelain v2 --branch -z 파서 검사.
// RED 기준: 파서 부재/오파싱(레코드 종류 1/2/u/?/!, -z 이름변경 2필드, 브랜치 헤더,
// ahead/behind, 데코레이션 분류 동등성). GREEN = 실 git 출력까지 왕복.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseStatusV2 } from "../src/status.js";

const NUL = "\0";

test("브랜치 헤더 — oid/head/upstream/ahead/behind", () => {
  const out = [
    "# branch.oid 1234abcd",
    "# branch.head main",
    "# branch.upstream origin/main",
    "# branch.ab +2 -1",
  ].join(NUL) + NUL;
  const r = parseStatusV2(out);
  assert.equal(r.branch.oid, "1234abcd");
  assert.equal(r.branch.head, "main");
  assert.equal(r.branch.upstream, "origin/main");
  assert.equal(r.branch.ahead, 2);
  assert.equal(r.branch.behind, 1);
  assert.deepEqual(r.entries, []);
  assert.equal(r.truncated, false);
});

test("레코드 분류 — 1(변경)/?(미추적)/!(무시), 데코레이션 동등성", () => {
  const out = [
    "1 .M N... 100644 100644 100644 abc def a.txt",
    "1 A. N... 000000 100644 100644 000 abc b.txt",
    "1 .D N... 100644 100644 000000 abc abc c.txt",
    "? new.txt",
    "! ignored.txt",
  ].join(NUL) + NUL;
  const r = parseStatusV2(out);
  assert.deepEqual(
    r.entries.map((e) => [e.path, e.status]),
    [
      ["a.txt", "modified"],
      ["b.txt", "added"],
      ["c.txt", "deleted"],
      ["new.txt", "untracked"],
      ["ignored.txt", "ignored"],
    ],
  );
  const a = r.entries[0];
  assert.equal(a.x, ".");
  assert.equal(a.y, "M");
});

test("이름변경(2 레코드) — -z 에서 원본 경로가 다음 NUL 필드로 온다", () => {
  const out =
    "2 R. N... 100644 100644 100644 abc abc R100 new-name.txt" + NUL + "old-name.txt" + NUL;
  const r = parseStatusV2(out);
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].path, "new-name.txt");
  assert.equal(r.entries[0].origPath, "old-name.txt");
  assert.equal(r.entries[0].status, "renamed");
});

test("병합 충돌(u 레코드)은 conflicted 로 분류된다", () => {
  const out = "u UU N... 100644 100644 100644 100644 a b c both.txt" + NUL;
  const r = parseStatusV2(out);
  assert.equal(r.entries[0].path, "both.txt");
  assert.equal(r.entries[0].status, "conflicted");
});

test("엔트리 상한 — 초과분은 자르고 truncated 를 세운다", () => {
  const out = Array.from({ length: 5 }, (_, i) => `? f${i}.txt`).join(NUL) + NUL;
  const r = parseStatusV2(out, { maxEntries: 3 });
  assert.equal(r.entries.length, 3);
  assert.equal(r.truncated, true);
});

// ── 실 git 왕복 — 픽스처는 ~/.soksak-e2e 고정 경로(멱등: 매 실행 재구성) ──
const FIX = join(homedir(), ".soksak-e2e", "git-core", "status-fix");

function git(dir, ...args) {
  return execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
}

test("실 git porcelain v2 출력 왕복 — 수정·추가·이름변경·미추적", () => {
  rmSync(FIX, { recursive: true, force: true });
  mkdirSync(FIX, { recursive: true });
  git(FIX, "init", "-b", "main");
  writeFileSync(join(FIX, "keep.txt"), "one\n");
  writeFileSync(join(FIX, "old.txt"), "content that is long enough to carry rename similarity\n");
  git(FIX, "add", ".");
  git(FIX, "commit", "-m", "first");

  writeFileSync(join(FIX, "keep.txt"), "one\ntwo\n"); // modified
  renameSync(join(FIX, "old.txt"), join(FIX, "new.txt")); // renamed (staged 후)
  git(FIX, "add", "-A");
  writeFileSync(join(FIX, "loose.txt"), "untracked\n"); // untracked

  const out = git(FIX, "status", "--porcelain=v2", "--branch", "-z");
  const r = parseStatusV2(out);
  assert.equal(r.branch.head, "main");
  const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e.status]));
  assert.equal(byPath["keep.txt"], "modified");
  assert.equal(byPath["new.txt"], "renamed");
  assert.equal(byPath["loose.txt"], "untracked");
  const renamed = r.entries.find((e) => e.path === "new.txt");
  assert.equal(renamed.origPath, "old.txt");

  rmSync(FIX, { recursive: true, force: true });
});
