// L1 변경 감시 — 감시 계획(어느 디렉토리를 보나)과 변경 분류(git.changed kind) 검사.
// RED 기준: 계획/분류 모듈 부재. 코어 fs-change 는 변경의 "부모 디렉토리"만 싣는다 —
// kind 는 디렉토리 단위(meta|refs)로 분류한다(§주의: 파일명 단위 *.lock 필터는 코어
// fs-change payload 가 파일명을 실을 때까지 debounce 로 갈음 — README 잔여 항목).
import test from "node:test";
import assert from "node:assert/strict";
import { watchDirs, classifyChange, makeTrailingDebounce } from "../src/watch.js";

test("감시 계획 — .git(비재귀)과 .git/refs/heads(비재귀) 두 곳", () => {
  assert.deepEqual(watchDirs("/w/repo"), ["/w/repo/.git", "/w/repo/.git/refs/heads"]);
});

test("변경 분류 — .git=meta, refs/heads=refs, 그 외=null", () => {
  assert.equal(classifyChange("/w/repo", "/w/repo/.git"), "meta");
  assert.equal(classifyChange("/w/repo", "/w/repo/.git/refs/heads"), "refs");
  assert.equal(classifyChange("/w/repo", "/w/repo/src"), null);
  assert.equal(classifyChange("/w/repo", "/other/.git"), null);
});

test("트레일링 디바운스 — 몰아치는 이벤트를 1발로 합치고 마지막 kind 집합을 전달", async () => {
  const fired = [];
  const push = makeTrailingDebounce(30, (kinds) => fired.push([...kinds].sort()));
  push("meta");
  push("meta");
  push("refs");
  await new Promise((r) => setTimeout(r, 80));
  push("meta");
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(fired, [["meta", "refs"], ["meta"]]);
});
