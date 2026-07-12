// soksak-plugin-git-core — git 실행 규약과 저장소 프리미티브의 단일진실.
// soksak-git-spec@1 의 구현체다(매니페스트 implements) — 명령 이름·인자·응답·거부 코드와
// 실행 규약은 계약이 정하고(SPEC.md), 적합성은 계약 repo 의 시험이 채점한다.
// 사다리: L0 발견(root·head)·init·clone / L1 status + git.changed 변경 이벤트 /
// L2 branch·worktree·삼점 diff / L3 stage·unstage·commit·discard·merge(위험 선언).
// 코어와의 접점은 generic 뿐이다: process(스폰)·fs.watch(경로 감시)·bus(이벤트).
// 실패 봉투 = { ok:false, code, message } (MESSAGE-PROTOCOL). git stderr 원문은
// 파싱하지 않고 메시지로만 전달한다(원인 노출 — convention.js).
import {
  NOT_REPO_RE,
  repoDirFromUrl,
  sanitizeCommit,
  validBranchName,
  validCloneUrl,
  validPath,
  validRef,
} from "./convention.js";
import { mergeFileList, parseNameStatus, parseNumstat } from "./range.js";
import { createGitRunner } from "./run.js";
import { parseStatusV2 } from "./status.js";
import { classifyChange, makeTrailingDebounce, watchDirs } from "./watch.js";
import { parseWorktreeList } from "./worktree.js";

const CHANGED_TOPIC = "git.changed";
const DEBOUNCE_MS = 300;

// 레거시 코어 log/show 와 같은 제어문자 레코드 포맷(subject 의 임의 문자와 충돌 없음).
const LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e";
const META_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s";

function parseLog(stdout) {
  const out = [];
  for (const rec of stdout.split("\x1e")) {
    const t = rec.trim();
    if (!t) continue;
    const f = t.split("\x1f");
    if (f.length !== 5) continue;
    out.push({ hash: f[0], short: f[1], author: f[2], date: f[3], subject: f[4] });
  }
  return out;
}

export default {
  activate(ctx) {
    const app = ctx.app;
    const msg = (en, ko) =>
      ((typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en);
    const err = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
    const runGit = createGitRunner(app.process);

    const resolvePath = (p) => {
      if (typeof p.path === "string" && p.path.trim()) return p.path;
      return app.project?.current?.()?.root ?? null;
    };
    const noPath = () =>
      err("NO_PATH", msg("no project root — pass path", "프로젝트 루트 없음 — path 를 지정하세요"));
    // git 이 실패를 설명한 스트림이 어느 쪽이든 그 원문 — porcelain 은 stdout 으로 서술하고
    // (merge 충돌: stdout 에 CONFLICT…, stderr 0바이트), fatal 은 stderr 로 낸다. stderr 만 읽으면
    // 충돌에 대고 "git exit 1" 이라고 답하게 된다 — git 이 이미 정확히 말해준 바로 그 경우에,
    // 사람에게 아무것도 알려주지 않는 유일한 문장을. 파싱은 여전히 없다(스트림을 고를 뿐).
    const gitDetail = (r) =>
      (r.stderr && r.stderr.trim()) || (r.stdout && r.stdout.trim()) || `git exit ${r.code}`;

    // 실패한 git 연산의 이름 — 인자에서 읽는다(사람 문장이 무엇이 실패했는지 말한다).
    const gitOp = (r) => {
      const a = r.args ?? [];
      return a[0] === "worktree" ? `worktree ${a[1] ?? ""}`.trim() : String(a[0] ?? "git");
    };

    // message 는 사람 문장이고 명령이 소유한다(MESSAGE-PROTOCOL §3). 엔진 방언을 그 줄에 실으면
    // 받는 쪽이 엔진의 말을 앱의 상태로 읽는다 — 원문은 버리지 않고 data.detail 로 내려보낸다.
    const gitErr = (r) =>
      err(
        "GIT_ERROR",
        msg(
          `git ${gitOp(r)} failed — git's own account is in detail`,
          `git ${gitOp(r)} 실패 — git 이 남긴 원문은 detail 에 있습니다`,
        ),
        { data: { detail: gitDetail(r) } },
      );

    // ── L1 감시 원장 — root → { dirs, disposables, since }. 관찰면(watch.list)이자
    //    unwatch-before-delete 계약의 실행 지점. 실패는 무음 폴백 없이 상태로 노출.
    const watches = new Map();

    async function startWatch(root) {
      if (watches.has(root)) return { already: true, root, watching: watches.get(root).dirs };
      const dirs = watchDirs(root);
      const debounced = makeTrailingDebounce(DEBOUNCE_MS, (kinds) => {
        for (const kind of kinds) app.bus.emit(CHANGED_TOPIC, { root, kind });
      });
      const granted = [];
      const disposables = [];
      for (const dir of dirs) {
        // 커맨드 경로로 등록 — 실패가 봉투로 보인다(api fs.watch 는 등록 실패를 삼킨다).
        const r = await app.commands.execute("fs.watch", { path: dir });
        if (!r.ok) {
          // 부분 성공 롤백 — 감시가 반쪽으로 살아남지 않는다.
          for (const g of granted) await app.commands.execute("fs.unwatch", { path: g });
          for (const d of disposables) d.dispose();
          return err(
            "WATCH_FAILED",
            msg(`cannot watch ${dir}: ${r.message}`, `감시 실패 ${dir}: ${r.message}`),
          );
        }
        granted.push(dir);
        disposables.push(
          app.fs.watch(dir, (changed) => {
            const kind = classifyChange(root, changed);
            if (kind) debounced(kind);
          }),
        );
      }
      const session = { root, dirs, disposables, since: Date.now() };
      watches.set(root, session);
      ctx.subscriptions.push({ dispose: () => void stopWatch(root) });
      return { root, watching: dirs };
    }

    async function stopWatch(root) {
      const s = watches.get(root);
      if (!s) return false;
      watches.delete(root);
      for (const d of s.disposables) d.dispose();
      for (const dir of s.dirs) await app.commands.execute("fs.unwatch", { path: dir });
      return true;
    }

    // unwatch-before-delete 계약 — dir 아래 감시를 삭제 전에 전부 해제한다.
    async function unwatchUnder(dir) {
      for (const root of [...watches.keys()]) {
        if (root === dir || root.startsWith(`${dir}/`)) await stopWatch(root);
      }
    }

    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));

    // ── L0 ──────────────────────────────────────────────────────────────
    reg("root", {
      description:
        "Locate the repository root for a directory. Tri-state result: repo (with root path), not-repo, or error — an unreadable path or missing git is an error, not not-repo.",
      triggers: { ko: "저장소 판별 루트 찾기 깃 저장소 여부" },
      params: { path: { type: "string", description: "Directory to probe (omit = project root)" } },
      returns: '{ state: "repo"|"not-repo"|"error", root?, error? }',
      examples: ['sok plugin.soksak-plugin-git-core.root \'{"path":"/Users/me/work"}\''],
      message: (d) =>
        d.state === "repo"
          ? msg(`repository: ${d.root}`, `저장소: ${d.root}`)
          : d.state === "not-repo"
            ? msg("not a repository", "저장소 아님")
            : msg("probe error", "판별 오류"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        try {
          const r = await runGit({ cwd: path, args: ["rev-parse", "--show-toplevel"] });
          if (r.code === 0) return { state: "repo", root: r.stdout.trim() };
          if (NOT_REPO_RE.test(r.stderr)) return { state: "not-repo" };
          return { state: "error", error: gitDetail(r) };
        } catch (e) {
          return { state: "error", error: String(e?.message ?? e) };
        }
      },
    });

    reg("head", {
      description:
        "Read what is checked out here: the branch, its commit oid, and whether HEAD is detached. A detached HEAD reports branch:null and detached:true — it is a state to show, not an error.",
      triggers: { ko: "현재 브랜치 확인 헤드 체크아웃" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ branch: string|null, oid, detached }",
      examples: ["sok plugin.soksak-plugin-git-core.head"],
      message: (d) =>
        d.detached
          ? msg(`detached at ${d.oid.slice(0, 7)}`, `분리된 HEAD ${d.oid.slice(0, 7)}`)
          : msg(`on ${d.branch}`, `${d.branch} 브랜치`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const name = await runGit({ cwd: path, args: ["rev-parse", "--abbrev-ref", "HEAD"] });
        if (name.code !== 0) return gitErr(name);
        const oid = await runGit({ cwd: path, args: ["rev-parse", "HEAD"] });
        if (oid.code !== 0) return gitErr(oid);
        // 분리 HEAD 에서 --abbrev-ref 는 "HEAD" 를 낸다 — 그게 브랜치명이 아니라는 신호다.
        const branch = name.stdout.trim();
        const detached = branch === "HEAD";
        return { branch: detached ? null : branch, oid: oid.stdout.trim(), detached };
      },
    });

    reg("init", {
      description:
        "Run git init with initial branch main when the directory has no .git. Idempotent — an existing repository is a no-op reported as initialized:false.",
      triggers: { ko: "깃 초기화 저장소 생성 init" },
      params: { path: { type: "string", description: "Directory to initialize (omit = project root)" } },
      returns: "{ initialized, path }",
      examples: ['sok plugin.soksak-plugin-git-core.init \'{"path":"/Users/me/work"}\''],
      message: (d) =>
        d.initialized
          ? msg("initialized", "저장소를 초기화했습니다")
          : msg("already a repository", "이미 저장소입니다"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const probe = await runGit({ cwd: path, args: ["rev-parse", "--show-toplevel"] });
        if (probe.code === 0 && probe.stdout.trim() === path) return { initialized: false, path };
        const r = await runGit({ cwd: path, args: ["init", "-b", "main"], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { initialized: true, path };
      },
    });

    reg("clone", {
      description:
        "Clone a repository into a validated directory name under the target path. The name derives from the URL (or the dir parameter) and must be a safe slug. Progress lines stream as command progress events.",
      triggers: { ko: "저장소 복제 클론 내려받기" },
      params: {
        url: { type: "string", description: "Clone URL (https/ssh/local path)", required: true },
        path: { type: "string", description: "Parent directory (omit = project root)" },
        dir: { type: "string", description: "Target directory name (default: derived from URL)" },
        branch: { type: "string", description: "Branch to check out" },
      },
      returns: "{ dir: absolute path of the clone }",
      examples: ['sok plugin.soksak-plugin-git-core.clone \'{"url":"https://github.com/user/repo.git"}\''],
      message: (d) => msg(`cloned: ${d.dir}`, `복제 완료: ${d.dir}`),
      handler: async (p) => {
        const parent = resolvePath(p);
        if (!parent) return noPath();
        // URL 검증이 먼저다 — 자격증명이 실린 URL 은 git 이 .git/config 에 평문으로 박제한다.
        if (!validCloneUrl(p.url)) {
          return err(
            "INVALID_URL",
            msg(
              "url not allowed — no credentials in the url (use the credential helper), no option-shaped url",
              "허용되지 않는 url — url 에 자격증명 금지(credential helper 사용), 옵션 형태 금지",
            ),
          );
        }
        const name = typeof p.dir === "string" && p.dir ? p.dir : repoDirFromUrl(p.url);
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
          return err("INVALID_URL", msg("cannot derive a safe directory name from url", "url 에서 안전한 디렉토리명을 유도할 수 없습니다"));
        }
        if (typeof p.branch === "string" && p.branch && !validBranchName(p.branch)) {
          return err("INVALID_BRANCH", msg("invalid branch name", "브랜치명 형식 위반"));
        }
        const args = ["clone", "--progress"];
        if (p.branch) args.push("-b", p.branch);
        args.push("--", String(p.url), name);
        const r = await runGit({
          cwd: parent,
          args,
          kind: "write",
          timeoutMs: 600_000,
          onStderrLine: (line) => app.events.progress("clone", { line }),
        });
        if (r.code !== 0) return gitErr(r);
        return { dir: `${parent}/${name}` };
      },
    });

    // ── L1 ──────────────────────────────────────────────────────────────
    reg("status", {
      description:
        "Read repository status via porcelain v2 with the branch header: branch name, upstream, ahead/behind, and per-path decoration classes (modified/added/deleted/renamed/untracked/ignored/conflicted). Entries cap at maxEntries with a truncated flag.",
      triggers: { ko: "저장소 상태 변경 파일 목록 스테이터스" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        maxEntries: { type: "number", description: "Entry cap (default 5000)" },
      },
      returns: "{ branch: {oid,head,upstream?,ahead?,behind?}, entries: [{path,x,y,status,origPath?}], truncated }",
      examples: ["sok plugin.soksak-plugin-git-core.status"],
      message: (d) => msg(`${d.entries.length} changed entries`, `변경 ${d.entries.length}건`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const r = await runGit({ cwd: path, args: ["status", "--porcelain=v2", "--branch", "-z"] });
        if (r.code !== 0) return gitErr(r);
        return parseStatusV2(r.stdout, { maxEntries: p.maxEntries });
      },
    });

    reg("watch.start", {
      description:
        "Start watching a repository for changes: .git and .git/refs/heads (non-recursive, OS events through core fs.watch). Emits the git.changed {root, kind} bus event, kind = meta (HEAD/index) or refs (branch tips). Watch registration failures fail this command — there is no silent fallback. Idempotent per root.",
      triggers: { ko: "저장소 변경 감시 시작 워치" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ root, watching: [dirs] } | { already: true, root, watching }",
      examples: ["sok plugin.soksak-plugin-git-core.watch.start"],
      message: (d) =>
        d.already ? msg("already watching", "이미 감시 중") : msg(`watching ${d.root}`, `감시 시작: ${d.root}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const probe = await runGit({ cwd: path, args: ["rev-parse", "--show-toplevel"] });
        if (probe.code !== 0) return gitErr(probe);
        return startWatch(probe.stdout.trim());
      },
    });

    reg("watch.stop", {
      description: "Stop watching a repository and release its core fs.watch subscriptions.",
      triggers: { ko: "저장소 변경 감시 중지 해제" },
      params: { path: { type: "string", description: "Repository root (omit = project root)" } },
      returns: "{ stopped: whether a watch session existed }",
      examples: ["sok plugin.soksak-plugin-git-core.watch.stop"],
      message: (d) => (d.stopped ? msg("stopped", "감시를 중지했습니다") : msg("was not watching", "감시 중이 아니었습니다")),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        return { stopped: await stopWatch(path) };
      },
    });

    reg("watch.list", {
      description:
        "List active repository watch sessions — the observable state of the change-event pipeline (which roots, which directories, since when).",
      triggers: { ko: "저장소 감시 목록 상태" },
      params: {},
      returns: "{ watches: [{root, dirs, since}] }",
      examples: ["sok plugin.soksak-plugin-git-core.watch.list"],
      message: (d) => msg(`${d.watches.length} watches`, `감시 ${d.watches.length}건`),
      handler: () => ({
        watches: [...watches.values()].map((s) => ({ root: s.root, dirs: s.dirs, since: s.since })),
      }),
    });

    // ── L2 ──────────────────────────────────────────────────────────────
    reg("branch.exists", {
      description:
        "Does a local branch exist? The question a consumer must answer before choosing between creating a worktree on a new branch and attaching one to the branch it already has.",
      triggers: { ko: "브랜치 존재 확인 있는지" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        branch: { type: "string", description: "Branch name", required: true },
      },
      returns: "{ exists }",
      examples: ['sok plugin.soksak-plugin-git-core.branch.exists \'{"branch":"feat/x"}\''],
      message: (d) => (d.exists ? msg("the branch exists", "브랜치가 있습니다") : msg("no such branch", "브랜치 없음")),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const branch = String(p.branch ?? "");
        if (!validBranchName(branch)) return err("INVALID_BRANCH", msg("invalid branch name", "브랜치명 형식 위반"));
        const r = await runGit({ cwd: path, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`] });
        if (r.code === 0) return { exists: true };
        if (r.code === 1) return { exists: false }; // git 의 "없음" — 오류가 아니다
        return gitErr(r);
      },
    });

    reg("worktree.add", {
      description:
        "Add a worktree. By default it creates a NEW branch at base (default HEAD), and records the base in repo config (soksak.worktree.<branch>.base). With attach:true it checks out an EXISTING branch instead — the reopen path, where the branch survived the last close and carries the work. Default dir is <root>-wt/<branch-slug>, overridable via dir.",
      triggers: { ko: "워크트리 추가 생성 브랜치 작업트리 재부착" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        branch: { type: "string", description: "Branch name — created, or attached with attach:true", required: true },
        base: { type: "string", description: "Base ref for a new branch (default HEAD); ignored with attach" },
        dir: { type: "string", description: "Worktree directory (default <root>-wt/<branch-slug>)" },
        attach: { type: "boolean", description: "Check out the existing branch instead of creating it", default: false },
      },
      returns: "{ dir, branch, base, attached }",
      examples: [
        'sok plugin.soksak-plugin-git-core.worktree.add \'{"branch":"feat/x"}\'',
        'sok plugin.soksak-plugin-git-core.worktree.add \'{"branch":"feat/x","attach":true}\'',
      ],
      message: (d) =>
        d.attached
          ? msg(`attached ${d.branch} at ${d.dir}`, `${d.branch} 재부착: ${d.dir}`)
          : msg(`worktree at ${d.dir}`, `워크트리 생성: ${d.dir}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const branch = String(p.branch ?? "");
        if (!validBranchName(branch)) return err("INVALID_BRANCH", msg("invalid branch name", "브랜치명 형식 위반"));
        const attach = p.attach === true;
        const base = typeof p.base === "string" && p.base ? p.base : "HEAD";
        if (!attach && base !== "HEAD" && !validRef(base)) {
          return err("INVALID_REF", msg("invalid base ref", "base 참조 형식 위반"));
        }
        const dir =
          typeof p.dir === "string" && p.dir ? p.dir : `${path}-wt/${branch.replaceAll("/", "-")}`;
        // 부착은 브랜치를 만들지 않는다 — 없는 브랜치에 부착하면 git 이 거부한다(무언 생성 금지).
        const args = attach
          ? ["worktree", "add", "--", dir, branch]
          : ["worktree", "add", "--no-track", "-b", branch, "--", dir, base];
        const r = await runGit({ cwd: path, args, kind: "write" });
        if (r.code !== 0) return gitErr(r);
        if (attach) return { dir, branch, base: null, attached: true };
        // base 박제 — 리뷰·머지 흐름이 분기점을 조회할 수 있게 repo config 에 남긴다.
        await runGit({ cwd: path, args: ["config", `soksak.worktree.${branch}.base`, base], kind: "write" });
        return { dir, branch, base, attached: false };
      },
    });

    reg("worktree.list", {
      description: "List worktrees (porcelain): path, HEAD, branch, and bare/detached/locked/prunable attributes.",
      triggers: { ko: "워크트리 목록 조회" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ worktrees: [{path, head?, branch?, bare?, detached?, locked?, prunable?}] }",
      examples: ["sok plugin.soksak-plugin-git-core.worktree.list"],
      message: (d) => msg(`${d.worktrees.length} worktrees`, `워크트리 ${d.worktrees.length}개`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const r = await runGit({ cwd: path, args: ["worktree", "list", "--porcelain", "-z"] });
        if (r.code !== 0) return gitErr(r);
        return { worktrees: parseWorktreeList(r.stdout) };
      },
    });

    reg("worktree.remove", {
      description:
        "Remove a worktree. Refuses when the worktree has uncommitted changes (git's unmerged protection) — use worktree.remove.force for that, deliberately. Watch sessions under the tree are released before removal.",
      triggers: { ko: "워크트리 제거 삭제" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        dir: { type: "string", description: "Worktree directory to remove", required: true },
      },
      returns: "{ removed: dir }",
      examples: ['sok plugin.soksak-plugin-git-core.worktree.remove \'{"dir":"/w/repo-wt/feat-x"}\''],
      message: (d) => msg(`removed ${d.removed}`, `워크트리 제거: ${d.removed}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const dir = String(p.dir ?? "");
        await unwatchUnder(dir); // unwatch-before-delete 계약
        const r = await runGit({ cwd: path, args: ["worktree", "remove", "--", dir], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { removed: dir };
      },
    });

    reg("worktree.remove.force", {
      danger: "destructive",
      description:
        "Force-remove a worktree, discarding its uncommitted changes. Separate from worktree.remove so the destructive path is an explicit, gated choice.",
      triggers: { ko: "워크트리 강제 제거 삭제" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        dir: { type: "string", description: "Worktree directory to remove", required: true },
      },
      returns: "{ removed: dir }",
      examples: ['sok plugin.soksak-plugin-git-core.worktree.remove.force \'{"dir":"/w/repo-wt/feat-x"}\''],
      message: (d) => msg(`force-removed ${d.removed}`, `워크트리 강제 제거: ${d.removed}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const dir = String(p.dir ?? "");
        await unwatchUnder(dir);
        const r = await runGit({ cwd: path, args: ["worktree", "remove", "--force", "--", dir], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { removed: dir };
      },
    });

    reg("worktree.prune", {
      description: "Prune stale worktree bookkeeping (removed directories, broken links).",
      triggers: { ko: "워크트리 정리 프룬" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ done: true }",
      examples: ["sok plugin.soksak-plugin-git-core.worktree.prune"],
      message: () => msg("pruned", "정리했습니다"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const r = await runGit({ cwd: path, args: ["worktree", "prune"], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { done: true };
      },
    });

    // ── L3 ──────────────────────────────────────────────────────────────
    const badPath = (f) =>
      err("INVALID_PATH", msg(`not a repository-relative path: ${f}`, `저장소 상대 경로가 아님: ${f}`));

    // files 파라미터의 단일 관문 — 경로 증명이 여기 한 곳에 있다. 명령마다 따로 검사하면
    // 언젠가 한 명령이 빠지고, 공격자는 그 명령을 고른다. { files } 또는 { error } 를 답한다.
    const requireFiles = (p) => {
      const files = Array.isArray(p.files) ? p.files.map(String) : [];
      if (files.length === 0) return { error: err("NO_FILES", msg("files required", "files 필요")) };
      for (const f of files) {
        if (!validPath(f)) return { error: badPath(f) };
      }
      return { files };
    };

    reg("stage", {
      danger: "destructive",
      description: "Stage files into the index (git add -- <files>). Files are repository-relative paths.",
      triggers: { ko: "스테이지 추가 변경 담기" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        files: { type: "array", description: "Repository-relative paths", required: true },
      },
      returns: "{ staged: [files] }",
      examples: ['sok plugin.soksak-plugin-git-core.stage \'{"files":["src/a.ts"]}\''],
      message: (d) => msg(`staged ${d.staged.length} files`, `${d.staged.length}개 파일 스테이지`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const picked = requireFiles(p);
        if (picked.error) return picked.error;
        const files = picked.files;
        const r = await runGit({ cwd: path, args: ["add", "--", ...files], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { staged: files };
      },
    });

    reg("unstage", {
      danger: "destructive",
      description: "Remove files from the index without touching the working tree (git restore --staged -- <files>).",
      triggers: { ko: "스테이지 해제 빼기" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        files: { type: "array", description: "Repository-relative paths", required: true },
      },
      returns: "{ unstaged: [files] }",
      examples: ['sok plugin.soksak-plugin-git-core.unstage \'{"files":["src/a.ts"]}\''],
      message: (d) => msg(`unstaged ${d.unstaged.length} files`, `${d.unstaged.length}개 파일 스테이지 해제`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const picked = requireFiles(p);
        if (picked.error) return picked.error;
        const files = picked.files;
        const r = await runGit({ cwd: path, args: ["restore", "--staged", "--", ...files], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { unstaged: files };
      },
    });

    reg("commit", {
      danger: "destructive",
      description:
        "Create a commit from the staged index with the given message. Identity comes from the repository/user git config; a missing identity fails with git's own guidance.",
      triggers: { ko: "커밋 생성 저장" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        message: { type: "string", description: "Commit message", required: true },
      },
      returns: "{ oid, subject }",
      examples: ['sok plugin.soksak-plugin-git-core.commit \'{"message":"Add feature"}\''],
      message: (d) => msg(`committed ${d.oid.slice(0, 7)}`, `커밋 완료 ${d.oid.slice(0, 7)}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const message = String(p.message ?? "").trim();
        if (!message) return err("NO_MESSAGE", msg("commit message required", "커밋 메시지 필요"));
        const r = await runGit({ cwd: path, args: ["commit", "-m", message], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        const head = await runGit({ cwd: path, args: ["rev-parse", "HEAD"] });
        return { oid: head.stdout.trim(), subject: message.split("\n")[0] };
      },
    });

    reg("discard", {
      danger: "destructive",
      description:
        "Discard working-tree changes for tracked files (git restore --staged --worktree). With untracked:true also deletes the listed untracked files — every path must prove it stays inside the repository (relative, no escape) or the whole command refuses.",
      triggers: { ko: "변경 파기 되돌리기 삭제" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        files: { type: "array", description: "Repository-relative paths", required: true },
        untracked: { type: "boolean", description: "Also delete listed untracked files", default: false },
      },
      returns: "{ discarded: [files] }",
      examples: ['sok plugin.soksak-plugin-git-core.discard \'{"files":["src/a.ts"]}\''],
      message: (d) => msg(`discarded ${d.discarded.length} files`, `${d.discarded.length}개 파일 파기`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const picked = requireFiles(p);
        if (picked.error) return picked.error;
        const files = picked.files;
        if (p.untracked === true) {
          const r = await runGit({ cwd: path, args: ["clean", "-f", "--", ...files], kind: "write" });
          if (r.code !== 0) return gitErr(r);
          return { discarded: files };
        }
        const r = await runGit({
          cwd: path,
          args: ["restore", "--staged", "--worktree", "--", ...files],
          kind: "write",
        });
        if (r.code !== 0) return gitErr(r);
        return { discarded: files };
      },
    });

    // ── 읽기 삼종(레거시 코어 이관 — 소비 플러그인 재배선용 동형 표면) ──
    reg("log", {
      description:
        "Read commit history in reverse-chronological order. Pagination via limit (default 50, max 500) and skip.",
      triggers: { ko: "커밋 이력 로그 히스토리" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        limit: { type: "number", description: "Maximum commits (default 50, max 500)" },
        skip: { type: "number", description: "Commits to skip for pagination" },
      },
      returns: "{ commits: [{hash, short, author, date, subject}] }",
      examples: ["sok plugin.soksak-plugin-git-core.log", 'sok plugin.soksak-plugin-git-core.log \'{"limit":10}\''],
      message: (d) => msg(`${d.commits.length} commits`, `커밋 ${d.commits.length}건`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const limit = String(Math.min(Number(p.limit) || 50, 500));
        const skip = String(Number(p.skip) || 0);
        const r = await runGit({
          cwd: path,
          args: ["log", "--date=iso", LOG_FORMAT, "-n", limit, "--skip", skip],
        });
        if (r.code !== 0) return gitErr(r);
        return { commits: parseLog(r.stdout) };
      },
    });

    reg("show", {
      description:
        "Show one commit in full: metadata, changed file list (status + path), and the raw patch. The ref passes the commit whitelist (hex 4-40, HEAD forms).",
      triggers: { ko: "커밋 상세 확인 패치" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        commit: { type: "string", description: "Commit hash (4-40 hex) or HEAD/HEAD~N/HEAD^", required: true },
      },
      returns: "{ meta, files: [{status, path}], patch }",
      examples: ['sok plugin.soksak-plugin-git-core.show \'{"commit":"HEAD"}\''],
      message: (d) => msg(`${d.files.length} files changed`, `변경 파일 ${d.files.length}개`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const commit = String(p.commit ?? "");
        if (!sanitizeCommit(commit)) return err("INVALID_REF", msg("ref not allowed", "허용되지 않는 커밋 참조"));
        const head = await runGit({
          cwd: path,
          args: ["show", commit, "--date=iso", META_FORMAT, "--name-status"],
        });
        if (head.code !== 0) return gitErr(head);
        const lines = head.stdout.split("\n").filter((l) => l.trim());
        const meta = parseLog(`${lines[0] ?? ""}\x1e`)[0];
        if (!meta) return err("GIT_ERROR", msg("cannot parse commit meta", "커밋 메타 파싱 실패"));
        const files = [];
        for (const line of lines.slice(1)) {
          const cols = line.split("\t");
          if (cols.length < 2) continue;
          files.push({ status: cols[0][0] ?? "", path: cols[cols.length - 1] });
        }
        const patch = await runGit({ cwd: path, args: ["show", commit, "--format=", "--patch"] });
        if (patch.code !== 0) return gitErr(patch);
        return { meta, files, patch: patch.stdout };
      },
    });

    reg("diff", {
      description:
        "Return the raw unified diff: the working tree by default, the index with staged:true, or one commit's patch with commit. Optional file narrows the diff behind the -- path boundary.",
      triggers: { ko: "변경 비교 diff 차이" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        file: { type: "string", description: "Limit to this repository-relative path" },
        commit: { type: "string", description: "Commit hash or HEAD form" },
        staged: { type: "boolean", description: "Diff the index instead of the working tree", default: false },
      },
      returns: "{ diff: unified diff text }",
      examples: ["sok plugin.soksak-plugin-git-core.diff", 'sok plugin.soksak-plugin-git-core.diff \'{"staged":true}\''],
      message: (d) => (String(d.diff ?? "").trim() ? msg("changes found", "변경 있음") : msg("no changes", "변경 없음")),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        let args;
        if (typeof p.commit === "string" && p.commit) {
          if (!sanitizeCommit(p.commit)) return err("INVALID_REF", msg("ref not allowed", "허용되지 않는 커밋 참조"));
          args = ["show", p.commit, "--format=", "--patch"];
        } else if (p.staged === true) {
          args = ["diff", "--cached"];
        } else {
          args = ["diff"];
        }
        if (typeof p.file === "string" && p.file) {
          if (!validPath(p.file)) return badPath(p.file);
          args.push("--", p.file);
        }
        const r = await runGit({ cwd: path, args });
        if (r.code !== 0) return gitErr(r);
        return { diff: r.stdout };
      },
    });

    // ── 삼점 diff (base...target) — "이 브랜치가 갈라진 뒤 무엇을 했나" ──────
    // 이점(base..target)이 아닌 이유: base 가 그 사이에 쌓은 커밋까지 이 브랜치가 한 일로 보고한다.
    // base 생략 시 로컬 기본 브랜치를 해소한다. 없으면 거부 — HEAD 로 조용히 대체하면 삼점의
    // 답이 늘 공집합이 되어 "변경 없음"처럼 보인다.
    async function resolveBase(path, raw) {
      if (typeof raw === "string" && raw) return validRef(raw) ? raw : false;
      for (const b of ["main", "master"]) {
        const r = await runGit({ cwd: path, args: ["show-ref", "--verify", "--quiet", `refs/heads/${b}`] });
        if (r.code === 0) return b;
      }
      return null;
    }
    const noBase = () =>
      err("NO_BASE", msg("no default branch — pass base", "기본 브랜치 없음 — base 를 지정하세요"));
    const badRef = () => err("INVALID_REF", msg("ref not allowed", "허용되지 않는 참조"));

    reg("diff.files", {
      description:
        "List what a branch changed since it diverged: the three-dot range base...target. Each file carries its status and its line counts; a binary file reports binary:true with null counts rather than pretending nothing changed.",
      triggers: { ko: "브랜치 변경 파일 목록 리뷰 대상 비교" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        base: { type: "string", description: "Base ref (omit = the local default branch)" },
        target: { type: "string", description: "Branch or commit under review", required: true },
      },
      returns: "{ base, target, files: [{path, status, oldPath?, added, deleted, binary}] }",
      examples: ['sok plugin.soksak-plugin-git-core.diff.files \'{"target":"feat/x"}\''],
      message: (d) => msg(`${d.files.length} files changed`, `변경 파일 ${d.files.length}개`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const target = String(p.target ?? "");
        if (!validRef(target)) return badRef();
        const base = await resolveBase(path, p.base);
        if (base === false) return badRef();
        if (base === null) return noBase();
        const range = `${base}...${target}`;
        const ns = await runGit({ cwd: path, args: ["diff", "--name-status", range] });
        if (ns.code !== 0) return gitErr(ns);
        const nm = await runGit({ cwd: path, args: ["diff", "--numstat", range] });
        if (nm.code !== 0) return gitErr(nm);
        return { base, target, files: mergeFileList(parseNameStatus(ns.stdout), parseNumstat(nm.stdout)) };
      },
    });

    reg("diff.range", {
      description:
        "The unified diff of the three-dot range base...target, optionally narrowed to one file behind the -- path boundary. The two-point diff command answers about the working tree; this one answers about a branch.",
      triggers: { ko: "브랜치 변경 내용 비교 리뷰 diff" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        base: { type: "string", description: "Base ref (omit = the local default branch)" },
        target: { type: "string", description: "Branch or commit under review", required: true },
        file: { type: "string", description: "Limit to this repository-relative path" },
      },
      returns: "{ base, target, diff }",
      examples: ['sok plugin.soksak-plugin-git-core.diff.range \'{"target":"feat/x","file":"src/a.ts"}\''],
      message: (d) => (d.diff.trim() ? msg("changes found", "변경 있음") : msg("no changes", "변경 없음")),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const target = String(p.target ?? "");
        if (!validRef(target)) return badRef();
        const base = await resolveBase(path, p.base);
        if (base === false) return badRef();
        if (base === null) return noBase();
        const args = ["diff", `${base}...${target}`];
        if (typeof p.file === "string" && p.file) {
          if (!validPath(p.file)) return badPath(p.file);
          args.push("--", p.file);
        }
        const r = await runGit({ cwd: path, args });
        if (r.code !== 0) return gitErr(r);
        return { base, target, diff: r.stdout };
      },
    });

    reg("merge", {
      danger: "destructive",
      description:
        "Merge a branch into what is checked out here. Defaults to --no-ff so the branch stays visible in the history instead of being fast-forwarded out of existence. A conflict is reported with git's own text and left exactly as git left it — this command never auto-resolves, auto-aborts, or auto-commits its way out.",
      triggers: { ko: "브랜치 머지 병합 합치기" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        target: { type: "string", description: "Branch or commit to merge in", required: true },
        noFf: { type: "boolean", description: "Keep the merge commit (default true)", default: true },
      },
      returns: "{ oid }",
      examples: ['sok plugin.soksak-plugin-git-core.merge \'{"target":"feat/x"}\''],
      message: (d) => msg(`merged at ${d.oid.slice(0, 7)}`, `머지 완료 ${d.oid.slice(0, 7)}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const target = String(p.target ?? "");
        if (!validRef(target)) return badRef();
        const args = ["merge"];
        if (p.noFf !== false) args.push("--no-ff");
        args.push("-m", `Merge ${target}`, "--", target);
        const r = await runGit({ cwd: path, args, kind: "write" });
        if (r.code !== 0) return gitErr(r);
        const head = await runGit({ cwd: path, args: ["rev-parse", "HEAD"] });
        if (head.code !== 0) return gitErr(head);
        return { oid: head.stdout.trim() };
      },
    });
  },

  deactivate() {},
};
