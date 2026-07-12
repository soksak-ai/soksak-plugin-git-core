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

test("validPath — 저장소 상대 경로만 통과(절대·탈출·옵션형·제어문자 거부)", async () => {
  const { validPath } = await import("../src/convention.js");
  assert.equal(validPath("src/a.ts"), true);
  assert.equal(validPath("a b.txt"), true); // 공백은 합법적인 파일명이다
  assert.equal(validPath("/etc/passwd"), false);
  assert.equal(validPath("../../etc/passwd"), false);
  assert.equal(validPath("--output=/tmp/x"), false);
  assert.equal(validPath(""), false);
  // NUL 은 argv 에 들어갈 수 없다 — 걸러내지 않으면 spawn 이 예외를 던진다(크래시는 거부가 아니다).
  assert.equal(validPath(`a${String.fromCharCode(0)}b`), false);
  assert.equal(validPath(`a${String.fromCharCode(10)}b`), false);
});

test("validCloneUrl — http(s) 자격증명 거부, ssh 사용자명은 허용", async () => {
  const { validCloneUrl } = await import("../src/convention.js");
  assert.equal(validCloneUrl("https://github.com/u/r.git"), true);
  assert.equal(validCloneUrl("git@github.com:u/r.git"), true); // scp 형 사용자명은 비밀이 아니다
  assert.equal(validCloneUrl("ssh://git@host/u/r.git"), true);
  // git 은 받은 URL 을 .git/config 에 그대로 적는다 — 토큰이 평문으로 디스크에 남는다.
  assert.equal(validCloneUrl("https://alice:s3cr3t@host/r.git"), false);
  assert.equal(validCloneUrl("https://ghp_token@host/r.git"), false);
  assert.equal(validCloneUrl("--upload-pack=touch /tmp/pwned"), false);
  assert.equal(validCloneUrl(""), false);
});
