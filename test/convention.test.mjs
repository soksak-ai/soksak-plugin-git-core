// git 실행 규약 단일진실 검사 (플랜 W8 G1).
// RED 기준: 규약 미적용 스폰은 부모 locale 을 상속해 출력이 가변이고(LC_ALL=ko_KR 등),
// ref 자유 문자열이 옵션 주입으로 통한다. GREEN = 전 스폰 env 고정 + ref 화이트리스트 +
// --end-of-options / "--" 경계.
import test from "node:test";
import assert from "node:assert/strict";
import {
  READ_ENV,
  WRITE_ENV,
  WRITE_TIMEOUT_MS,
  sanitizeCommit,
  validBranchName,
  repoDirFromUrl,
} from "../src/convention.js";
import { createGitRunner } from "../src/run.js";
import { recordingProcessApi } from "./helpers/mock-process.mjs";

test("읽기 env 는 LC_ALL/LANG=C + GIT_OPTIONAL_LOCKS=0 으로 고정된다", () => {
  assert.equal(READ_ENV.LC_ALL, "C");
  assert.equal(READ_ENV.LANG, "C");
  assert.equal(READ_ENV.GIT_OPTIONAL_LOCKS, "0");
});

test("쓰기 env 는 locale 고정만 — 필수 잠금을 막지 않는다", () => {
  assert.equal(WRITE_ENV.LC_ALL, "C");
  assert.equal(WRITE_ENV.LANG, "C");
  assert.equal(WRITE_ENV.GIT_OPTIONAL_LOCKS, undefined);
});

test("모든 스폰이 규약 env 를 싣는다 — 부모 locale 이 새지 않는다(G1)", async () => {
  const { api, calls } = recordingProcessApi({ stdout: "", code: 0 });
  const runGit = createGitRunner(api);
  await runGit({ cwd: "/tmp/x", args: ["status", "--porcelain=v2", "-z"], kind: "read" });
  await runGit({ cwd: "/tmp/x", args: ["commit", "-m", "m"], kind: "write" });
  assert.equal(calls.length, 2);
  const [read, write] = calls;
  assert.equal(read.opts.env.LC_ALL, "C");
  assert.equal(read.opts.env.GIT_OPTIONAL_LOCKS, "0");
  assert.equal(write.opts.env.LC_ALL, "C");
  assert.equal(write.opts.env.GIT_OPTIONAL_LOCKS, undefined);
  assert.equal(read.cmd, "git");
});

test("쓰기 timeout 은 180s (클라우드 placeholder stall 대비)", () => {
  assert.equal(WRITE_TIMEOUT_MS, 180_000);
});

test("커밋 ref 화이트리스트 — hex 4~40 / HEAD / HEAD^ / HEAD~N 만", () => {
  assert.ok(sanitizeCommit("abc123"));
  assert.ok(sanitizeCommit("a1b2c3d4".repeat(5)));
  assert.ok(sanitizeCommit("HEAD"));
  assert.ok(sanitizeCommit("HEAD^"));
  assert.ok(sanitizeCommit("HEAD~3"));
  assert.equal(sanitizeCommit("--output=x"), false);
  assert.equal(sanitizeCommit("main; rm"), false);
  assert.equal(sanitizeCommit("-x"), false);
  assert.equal(sanitizeCommit(""), false);
  assert.equal(sanitizeCommit("HEAD~"), false);
});

test("브랜치명 규칙 — 옵션 주입·잠금 접미·상대 경로 탈출 차단", () => {
  assert.ok(validBranchName("feat/thing"));
  assert.ok(validBranchName("w8-m2"));
  assert.equal(validBranchName("-x"), false);
  assert.equal(validBranchName("a..b"), false);
  assert.equal(validBranchName("a.lock"), false);
  assert.equal(validBranchName("a/"), false);
  assert.equal(validBranchName(""), false);
  assert.equal(validBranchName("a b"), false);
});

test("clone 대상 디렉토리명은 url 에서 검증 유도 — 슬러그 밖은 거부", () => {
  assert.equal(repoDirFromUrl("https://github.com/soksak-ai/soksak-plugin-git-core.git"), "soksak-plugin-git-core");
  assert.equal(repoDirFromUrl("git@github.com:me/my.repo.git"), "my.repo");
  assert.equal(repoDirFromUrl("https://x.test/a/--evil"), null);
  assert.equal(repoDirFromUrl("https://x.test/"), null);
});
