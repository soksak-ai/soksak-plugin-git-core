// 커맨드 동작 — 실 git 왕복(mock 호스트 + node process 어댑터, 앱 불요).
// 픽스처는 ~/.soksak-e2e/git-core 고정 경로(멱등: 매 실행 재구성·정리).
// 핵심 계약:
//   L0 root tri-state(오류≠not-repo) / init 멱등 / clone(대상명 검증·progress)
//   L1 status(v2 --branch) / watch(시작·중지·목록, git.changed 발행, 실패 무음 금지)
//   L2 worktree(--no-track -b·base 박제·unmerged 보호 G4·force 는 별도 위험)
//   L3 stage/unstage/commit/discard(경로 증명 없는 untracked 삭제 거부)
//   unwatch-before-delete — 삭제 전 감시 해제 순서.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { mockApp } from "./helpers/mock-app.mjs";
import { nodeProcessApi } from "./helpers/mock-process.mjs";

const BASE = join(homedir(), ".soksak-e2e", "git-core");
const plugin = (await import("../main.js")).default;

function git(dir, ...args) {
  return execFileSync(
    "git",
    ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" } },
  );
}

function freshDir(name) {
  const dir = join(BASE, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 커밋 1개 있는 픽스처 repo.
function fixtureRepo(name) {
  const dir = freshDir(name);
  git(dir, "init", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "first");
  return dir;
}

function harness(opts = {}) {
  const m = mockApp({ process: nodeProcessApi(), ...opts });
  plugin.activate(m.ctx);
  const run = (name, params) => m.registered.get(name).handler(params ?? {});
  return { ...m, run };
}

// git identity 를 커밋 명령에 주입하기 어려우므로(규약 env 만 싣는다), 픽스처 repo 에
// 로컬 identity 를 박아 커밋 계열을 검증한다.
function setIdentity(dir) {
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  git(dir, "config", "commit.gpgsign", "false");
}

test("L0 root — tri-state: repo / not-repo / error 를 구분한다", async () => {
  const { run } = harness();
  const repo = fixtureRepo("root-repo");
  const plain = freshDir("root-plain");

  const a = await run("root", { path: repo });
  assert.equal(a.state, "repo");
  assert.equal(a.root, repo);

  const b = await run("root", { path: plain });
  assert.equal(b.state, "not-repo");
  assert.equal(b.ok, undefined); // not-repo 는 실패가 아니다(판별 결과)

  const c = await run("root", { path: join(BASE, "no-such-dir") });
  assert.equal(c.state, "error");
});

test("L0 init — 멱등: 없으면 init, 있으면 no-op", async () => {
  const { run } = harness();
  const dir = freshDir("init-fix");
  const first = await run("init", { path: dir });
  assert.equal(first.initialized, true);
  const again = await run("init", { path: dir });
  assert.equal(again.initialized, false);
  assert.ok(existsSync(join(dir, ".git")));
});

test("L0 clone — 로컬 원본 복제 + 대상 디렉토리명 검증 + progress 스트림", async () => {
  const { run, progress } = harness();
  const origin = fixtureRepo("clone-origin");
  const parent = freshDir("clone-parent");

  const bad = await run("clone", { url: "https://x.test/", path: parent });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "INVALID_URL");

  const r = await run("clone", { url: origin, path: parent, dir: "cloned" });
  assert.equal(r.ok, undefined, r.message);
  assert.ok(existsSync(join(parent, "cloned", ".git")));
  assert.ok(existsSync(join(parent, "cloned", "a.txt")));
  assert.ok(progress.some((p) => p.command === "clone"));
});

test("L1 status — 브랜치·분류 (v2 --branch 승격)", async () => {
  const { run } = harness();
  const dir = fixtureRepo("status-cmd");
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "loose.txt"), "x\n");
  const r = await run("status", { path: dir });
  assert.equal(r.branch.head, "main");
  const byPath = Object.fromEntries(r.entries.map((e) => [e.path, e.status]));
  assert.equal(byPath["a.txt"], "modified");
  assert.equal(byPath["loose.txt"], "untracked");
});

test("L1 watch — 시작·목록·중지, fs-change → git.changed{root,kind} 발행", async () => {
  const h = harness();
  const dir = fixtureRepo("watch-cmd");

  const started = await h.run("watch.start", { path: dir });
  assert.equal(started.ok, undefined, started.message);
  assert.deepEqual(started.watching, [`${dir}/.git`, `${dir}/.git/refs/heads`]);

  const listed = await h.run("watch.list", {});
  assert.equal(listed.watches.length, 1);
  assert.equal(listed.watches[0].root, dir);

  // 같은 root 재시작은 멱등.
  const again = await h.run("watch.start", { path: dir });
  assert.equal(again.already, true);

  // fs-change 시뮬레이션 → 디바운스 후 git.changed 발행.
  h.fireFsChange(`${dir}/.git`);
  h.fireFsChange(`${dir}/.git/refs/heads`);
  await new Promise((r) => setTimeout(r, 500));
  const kinds = h.busEvents.filter((e) => e.topic === "git.changed").map((e) => e.payload.kind).sort();
  assert.deepEqual(kinds, ["meta", "refs"]);
  assert.ok(h.busEvents.every((e) => e.payload.root === dir));

  const stopped = await h.run("watch.stop", { path: dir });
  assert.equal(stopped.stopped, true);
  assert.equal((await h.run("watch.list", {})).watches.length, 0);
});

test("L1 watch — 코어 fs.watch 실패는 무음 폴백 없이 실패로 노출", async () => {
  const h = harness({
    executeCommand: (name) =>
      name === "fs.watch"
        ? { ok: false, code: "INTERNAL", message: "watch failed" }
        : { ok: true, code: "OK", message: "", data: {} },
  });
  const dir = fixtureRepo("watch-fail");
  const r = await h.run("watch.start", { path: dir });
  assert.equal(r.ok, false);
  assert.equal(r.code, "WATCH_FAILED");
});

test("L2 worktree — add(--no-track -b·base 박제)·list·G4 unmerged 보호·force·prune", async () => {
  const { run } = harness();
  const dir = fixtureRepo("wt-cmd");
  const wtDir = join(BASE, "wt-cmd-tree");
  rmSync(wtDir, { recursive: true, force: true });

  const bad = await run("worktree.add", { path: dir, branch: "-evil", dir: wtDir });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, "INVALID_BRANCH");

  const added = await run("worktree.add", { path: dir, branch: "feat/x", dir: wtDir });
  assert.equal(added.ok, undefined, added.message);
  assert.equal(added.branch, "feat/x");
  assert.equal(added.base, "HEAD");
  // base 박제 — repo config 에 남는다.
  assert.equal(git(dir, "config", "soksak.worktree.feat/x.base").trim(), "HEAD");
  // --no-track — upstream 이 없다.
  assert.throws(() => git(wtDir, "rev-parse", "--abbrev-ref", "feat/x@{upstream}"));

  const listed = await run("worktree.list", { path: dir });
  assert.equal(listed.worktrees.length, 2);
  assert.ok(listed.worktrees.some((w) => w.branch === "feat/x"));

  // G4 — dirty worktree 는 remove 가 거부하고, 브랜치도 살아남는다.
  writeFileSync(join(wtDir, "dirty.txt"), "x\n");
  const refused = await run("worktree.remove", { path: dir, dir: wtDir });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "GIT_ERROR");
  assert.ok(existsSync(wtDir), "거부됐는데 트리가 사라짐");
  git(dir, "rev-parse", "--verify", "feat/x"); // 브랜치 생존

  // force 는 별도 위험 명령으로만.
  const forced = await run("worktree.remove.force", { path: dir, dir: wtDir });
  assert.equal(forced.ok, undefined, forced.message);
  assert.ok(!existsSync(wtDir));
  git(dir, "rev-parse", "--verify", "feat/x"); // 브랜치는 여전히 생존(remove 는 트리만)

  const pruned = await run("worktree.prune", { path: dir });
  assert.equal(pruned.done, true);
});

test("unwatch-before-delete — worktree.remove 는 삭제 전에 그 트리의 감시를 해제한다", async () => {
  const h = harness();
  const dir = fixtureRepo("wt-unwatch");
  const wtDir = join(BASE, "wt-unwatch-tree");
  rmSync(wtDir, { recursive: true, force: true });
  await h.run("worktree.add", { path: dir, branch: "w", dir: wtDir });
  const started = await h.run("watch.start", { path: wtDir });
  assert.equal(started.ok, undefined, started.message);

  const removed = await h.run("worktree.remove", { path: dir, dir: wtDir });
  assert.equal(removed.ok, undefined, removed.message);
  // 감시 해제(api-unwatch·fs.unwatch 커맨드)가 일어났고, 목록에서 사라졌다.
  assert.ok(h.watchCalls.some((c) => c.kind === "api-unwatch" && c.dir.startsWith(wtDir)));
  assert.equal((await h.run("watch.list", {})).watches.length, 0);
});

test("L3 stage/unstage/commit/discard — 왕복 + untracked 삭제 경로 증명", async () => {
  const { run } = harness();
  const dir = fixtureRepo("l3-cmd");
  setIdentity(dir);

  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  const staged = await run("stage", { path: dir, files: ["a.txt"] });
  assert.equal(staged.ok, undefined, staged.message);
  assert.match(git(dir, "status", "--porcelain"), /^M {2}a\.txt/m);

  const unstaged = await run("unstage", { path: dir, files: ["a.txt"] });
  assert.equal(unstaged.ok, undefined, unstaged.message);
  assert.match(git(dir, "status", "--porcelain"), /^ M a\.txt/m);

  await run("stage", { path: dir, files: ["a.txt"] });
  const committed = await run("commit", { path: dir, message: "second" });
  assert.equal(committed.ok, undefined, committed.message);
  assert.equal(committed.oid.length, 40);
  assert.match(git(dir, "log", "-1", "--format=%s"), /second/);

  // discard — 추적 파일 변경 파기.
  writeFileSync(join(dir, "a.txt"), "changed again\n");
  const discarded = await run("discard", { path: dir, files: ["a.txt"] });
  assert.equal(discarded.ok, undefined, discarded.message);
  assert.equal(git(dir, "status", "--porcelain").trim(), "");

  // discard untracked — 경로 증명 실패는 거부, 증명 통과만 삭제.
  writeFileSync(join(dir, "loose.txt"), "x\n");
  const escape = await run("discard", { path: dir, files: ["../escape.txt"], untracked: true });
  assert.equal(escape.ok, false);
  assert.equal(escape.code, "PATH_OUTSIDE_REPO");
  const abs = await run("discard", { path: dir, files: ["/etc/hosts"], untracked: true });
  assert.equal(abs.ok, false);
  const cleaned = await run("discard", { path: dir, files: ["loose.txt"], untracked: true });
  assert.equal(cleaned.ok, undefined, cleaned.message);
  assert.ok(!existsSync(join(dir, "loose.txt")));
});

test("읽기 삼종 — log/show/diff (레거시 코어와 같은 형태)", async () => {
  const { run } = harness();
  const dir = fixtureRepo("read-cmd");
  setIdentity(dir);
  writeFileSync(join(dir, "a.txt"), "one\ntwo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "second");

  const log = await run("log", { path: dir, limit: 10 });
  assert.equal(log.commits.length, 2);
  assert.equal(log.commits[0].subject, "second");
  assert.equal(log.commits[0].hash.length, 40);

  const show = await run("show", { path: dir, commit: log.commits[0].hash });
  assert.equal(show.meta.subject, "second");
  assert.deepEqual(show.files, [{ status: "M", path: "a.txt" }]);
  assert.match(show.patch, /\+two/);

  const badRef = await run("show", { path: dir, commit: "main; rm" });
  assert.equal(badRef.ok, false);
  assert.equal(badRef.code, "INVALID_REF");

  writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\n");
  const diff = await run("diff", { path: dir, file: "a.txt" });
  assert.match(diff.diff, /\+three/);
});

test("path 미지정 — 프로젝트 루트 폴백, 그것도 없으면 명시 에러", async () => {
  const dir = fixtureRepo("fallback-cmd");
  const withProject = harness({ project: { id: "p", root: dir } });
  const r = await withProject.run("status", {});
  assert.equal(r.branch.head, "main");

  const without = harness();
  const e = await without.run("status", {});
  assert.equal(e.ok, false);
  assert.equal(e.code, "NO_PATH");
});
