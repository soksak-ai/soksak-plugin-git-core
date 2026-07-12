// L2 worktree — porcelain 목록 파서 검사.
// RED 기준: 파서 부재/오파싱(레코드 블록, bare/detached/locked/prunable 속성).
import test from "node:test";
import assert from "node:assert/strict";
import { parseWorktreeList } from "../src/worktree.js";

test("worktree list --porcelain -z — 블록 파싱", () => {
  const NUL = "\0";
  const out =
    ["worktree /w/main", "HEAD 1111", "branch refs/heads/main"].join(NUL) +
    NUL + NUL +
    ["worktree /w/feat", "HEAD 2222", "branch refs/heads/feat/x"].join(NUL) +
    NUL + NUL +
    ["worktree /w/detached", "HEAD 3333", "detached"].join(NUL) +
    NUL + NUL;
  const list = parseWorktreeList(out);
  assert.equal(list.length, 3);
  assert.deepEqual(list[0], { path: "/w/main", head: "1111", branch: "main" });
  assert.deepEqual(list[1], { path: "/w/feat", head: "2222", branch: "feat/x" });
  assert.deepEqual(list[2], { path: "/w/detached", head: "3333", detached: true });
});

test("locked/prunable/bare 속성이 실린다", () => {
  const NUL = "\0";
  const out =
    ["worktree /w/bare", "bare"].join(NUL) +
    NUL + NUL +
    ["worktree /w/locked", "HEAD 4444", "branch refs/heads/b", "locked reason text"].join(NUL) +
    NUL + NUL +
    ["worktree /w/gone", "HEAD 5555", "detached", "prunable gitdir file points to non-existent location"].join(NUL) +
    NUL + NUL;
  const list = parseWorktreeList(out);
  assert.deepEqual(list[0], { path: "/w/bare", bare: true });
  assert.equal(list[1].locked, "reason text");
  assert.equal(list[2].prunable, "gitdir file points to non-existent location");
});
