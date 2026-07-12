// 삼점 diff 순수부 — name-status/numstat 파싱·병합과 ref 게이트.
// RED 기준: 이름변경 경로 오해(numstat 의 "{old => new}" 표기), 바이너리를 0줄로 보고,
//           range 문법(".." )·옵션 주입("-x")이 ref 로 통과.
import test from "node:test";
import assert from "node:assert/strict";
import { validRef } from "../src/convention.js";
import { mergeFileList, parseNameStatus, parseNumstat } from "../src/range.js";

test("name-status — 상태 문자와 이름변경 원본 경로", () => {
  const out = ["M\ta.txt", "D\tb.txt", "A\tnew.txt", "R100\told.txt\tnew/moved.txt"].join("\n");
  assert.deepEqual(parseNameStatus(out), [
    { status: "modified", path: "a.txt" },
    { status: "deleted", path: "b.txt" },
    { status: "added", path: "new.txt" },
    { status: "renamed", path: "new/moved.txt", oldPath: "old.txt" },
  ]);
});

test("numstat — 바이너리는 0줄이 아니라 셀 수 없음이다", () => {
  const m = parseNumstat(["1\t0\ta.txt", "-\t-\timg.png"].join("\n"));
  assert.deepEqual(m.get("a.txt"), { added: 1, deleted: 0, binary: false });
  assert.deepEqual(m.get("img.png"), { added: null, deleted: null, binary: true });
});

test("numstat — 이름변경 표기에서 새 경로만 남는다(name-status 와 키가 맞는다)", () => {
  const m = parseNumstat(["3\t1\tsrc/{old => new}/a.txt", "2\t0\told.txt => moved.txt"].join("\n"));
  assert.ok(m.has("src/new/a.txt"), `keys: ${[...m.keys()]}`);
  assert.ok(m.has("moved.txt"), `keys: ${[...m.keys()]}`);
});

test("병합 — 상태가 주(主), 줄 수는 부가. numstat 에 없는 파일도 빠지지 않는다", () => {
  const files = mergeFileList(
    [
      { status: "modified", path: "a.txt" },
      { status: "deleted", path: "gone.txt" },
    ],
    parseNumstat("1\t0\ta.txt"),
  );
  assert.deepEqual(files, [
    { path: "a.txt", status: "modified", added: 1, deleted: 0, binary: false },
    { path: "gone.txt", status: "deleted", added: null, deleted: null, binary: false },
  ]);
});

test("validRef — 브랜치명과 커밋은 통과, range 문법·옵션 주입은 거부", () => {
  assert.equal(validRef("feat/x"), true);
  assert.equal(validRef("main"), true);
  assert.equal(validRef("HEAD"), true);
  assert.equal(validRef("a1b2c3d"), true);
  assert.equal(validRef("main..feat/x"), false); // range 는 우리가 조립한다
  assert.equal(validRef("main...feat/x"), false);
  assert.equal(validRef("-x"), false);
  assert.equal(validRef("--upload-pack=touch"), false);
  assert.equal(validRef("../../etc"), false);
  assert.equal(validRef("x.lock"), false);
});
