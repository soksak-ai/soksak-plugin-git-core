// src/convention.js
var READ_ENV = Object.freeze({ LC_ALL: "C", LANG: "C", GIT_OPTIONAL_LOCKS: "0" });
var WRITE_ENV = Object.freeze({ LC_ALL: "C", LANG: "C" });
var READ_TIMEOUT_MS = 3e4;
var WRITE_TIMEOUT_MS = 18e4;
function envFor(kind) {
  return kind === "write" ? { ...WRITE_ENV } : { ...READ_ENV };
}
function timeoutFor(kind) {
  return kind === "write" ? WRITE_TIMEOUT_MS : READ_TIMEOUT_MS;
}
function sanitizeCommit(c) {
  if (typeof c !== "string") return false;
  if (c.length >= 4 && c.length <= 40 && /^[0-9a-fA-F]+$/.test(c)) return true;
  if (c === "HEAD" || c === "HEAD^") return true;
  const n = c.startsWith("HEAD~") ? c.slice(5) : null;
  return n !== null && n.length > 0 && /^[0-9]+$/.test(n);
}
function validBranchName(b) {
  if (typeof b !== "string" || b.length === 0) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(b)) return false;
  if (b.includes("..") || b.endsWith(".lock") || b.endsWith("/") || b.endsWith(".")) return false;
  return true;
}
function validRef(r) {
  return validBranchName(r) || sanitizeCommit(r);
}
function repoDirFromUrl(url) {
  if (typeof url !== "string") return null;
  const trimmed = url.replace(/\/+$/, "");
  let tail;
  if (trimmed.includes("://")) {
    const segs = trimmed.slice(trimmed.indexOf("://") + 3).split("/");
    if (segs.length < 2) return null;
    tail = segs[segs.length - 1];
  } else if (trimmed.includes(":")) {
    const segs = trimmed.slice(trimmed.lastIndexOf(":") + 1).split("/");
    tail = segs[segs.length - 1];
  } else {
    const segs = trimmed.split("/");
    if (segs.length < 2) return null;
    tail = segs[segs.length - 1];
  }
  const name = tail.endsWith(".git") ? tail.slice(0, -4) : tail;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return null;
  return name;
}
var NOT_REPO_RE = /not a git repository/i;
var CONTROL_RE = /[\u0000-\u001f\u007f]/;
function validPath(rel) {
  if (typeof rel !== "string" || rel.length === 0) return false;
  if (rel.startsWith("/") || rel.startsWith("-")) return false;
  if (CONTROL_RE.test(rel)) return false;
  const parts = rel.split("/");
  if (parts.includes("..") || parts.includes("")) return false;
  return true;
}
function validCloneUrl(url) {
  if (typeof url !== "string" || url.length === 0) return false;
  if (url.startsWith("-") || CONTROL_RE.test(url)) return false;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/]*)/.exec(url);
  if (m) {
    const scheme = m[1].toLowerCase();
    if ((scheme === "http" || scheme === "https") && m[2].includes("@")) return false;
  }
  return true;
}

// src/range.js
var STATUS = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "typechange",
  U: "unmerged"
};
function parseNameStatus(stdout) {
  const out = [];
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("	");
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
function parseNumstat(stdout) {
  const map = /* @__PURE__ */ new Map();
  for (const line of String(stdout).split("\n")) {
    if (!line.trim()) continue;
    const cols = line.split("	");
    if (cols.length < 3) continue;
    const added = cols[0] === "-" ? null : Number(cols[0]);
    const deleted = cols[1] === "-" ? null : Number(cols[1]);
    let path = cols.slice(2).join("	");
    if (path.includes(" => ")) {
      path = path.replace(/\{[^}]*? => ([^}]*?)\}/g, "$1").replace(/^.* => /, "");
    }
    map.set(path, { added, deleted, binary: added === null && deleted === null });
  }
  return map;
}
function mergeFileList(entries, counts) {
  return (entries ?? []).map((f) => {
    const n = counts?.get(f.path) ?? {};
    return {
      path: f.path,
      status: f.status,
      ...f.oldPath ? { oldPath: f.oldPath } : {},
      added: n.added ?? null,
      deleted: n.deleted ?? null,
      binary: n.binary === true
    };
  });
}

// src/run.js
function createGitRunner(processApi) {
  return function runGit({ cwd, args, kind = "read", timeoutMs, onStderrLine }) {
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? timeoutFor(kind);
      const dec = new TextDecoder();
      let out = "";
      let err = "";
      let errLine = "";
      let done = false;
      let timer = null;
      processApi.spawn("git", args, { cwd, env: envFor(kind) }).then((handle) => {
        const disposables = [];
        const finish = (fn, v) => {
          if (done) return;
          done = true;
          if (timer) clearTimeout(timer);
          for (const d of disposables) d.dispose();
          fn(v);
        };
        timer = setTimeout(() => {
          void processApi.kill(handle);
          finish(reject, new Error(`git ${args[0] ?? ""} timeout ${limit}ms`));
        }, limit);
        disposables.push(
          processApi.onData(handle, (b) => {
            out += dec.decode(b, { stream: true });
          }),
          processApi.onStderr(handle, (b) => {
            const chunk = new TextDecoder().decode(b);
            err += chunk;
            if (onStderrLine) {
              errLine += chunk;
              let i;
              while ((i = errLine.search(/[\r\n]/)) >= 0) {
                const line = errLine.slice(0, i).trim();
                errLine = errLine.slice(i + 1);
                if (line) onStderrLine(line);
              }
            }
          }),
          processApi.onExit(handle, (code) => {
            finish(resolve, { code, stdout: out, stderr: err.trim(), args });
          })
        );
      }).catch((e) => {
        if (!done) {
          done = true;
          if (timer) clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    });
  };
}

// src/status.js
function classifyXY(x, y) {
  if (x === "?" || y === "?") return "untracked";
  if (x === "D" || y === "D") return "deleted";
  if (x === "R" || y === "R" || x === "C" || y === "C") return "renamed";
  if (x === "A" || y === "A") return "added";
  return "modified";
}
var DEFAULT_MAX_ENTRIES = 5e3;
function parseStatusV2(stdout, opts = {}) {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const branch = {};
  const entries = [];
  let truncated = false;
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i];
    if (!rec) continue;
    if (rec.startsWith("# ")) {
      const [key, ...rest] = rec.slice(2).split(" ");
      const val = rest.join(" ");
      if (key === "branch.oid") branch.oid = val;
      else if (key === "branch.head") branch.head = val;
      else if (key === "branch.upstream") branch.upstream = val;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(val);
        if (m) {
          branch.ahead = Number(m[1]);
          branch.behind = Number(m[2]);
        }
      }
      continue;
    }
    const push = (entry) => {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      entries.push(entry);
    };
    const kind = rec[0];
    if (kind === "?" || kind === "!") {
      push({
        path: rec.slice(2),
        x: kind,
        y: kind,
        status: kind === "?" ? "untracked" : "ignored"
      });
      continue;
    }
    if (kind === "1") {
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      const path = f.slice(8).join(" ");
      push({ path, x: xy[0], y: xy[1], status: classifyXY(xy[0], xy[1]) });
      continue;
    }
    if (kind === "2") {
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      const path = f.slice(9).join(" ");
      const origPath = fields[++i] ?? "";
      push({ path, origPath, x: xy[0], y: xy[1], status: classifyXY(xy[0], xy[1]) });
      continue;
    }
    if (kind === "u") {
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      const path = f.slice(10).join(" ");
      push({ path, x: xy[0], y: xy[1], status: "conflicted" });
    }
  }
  return { branch, entries, truncated };
}

// src/watch.js
function watchDirs(root) {
  return [`${root}/.git`, `${root}/.git/refs/heads`];
}
function classifyChange(root, dir) {
  if (dir === `${root}/.git`) return "meta";
  if (dir === `${root}/.git/refs/heads`) return "refs";
  return null;
}
function makeTrailingDebounce(ms, fire) {
  let timer = null;
  let kinds = /* @__PURE__ */ new Set();
  return (kind) => {
    kinds.add(kind);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = kinds;
      kinds = /* @__PURE__ */ new Set();
      timer = null;
      fire(batch);
    }, ms);
  };
}

// src/worktree.js
function parseWorktreeList(stdout) {
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
    const val = sp < 0 ? void 0 : rec.slice(sp + 1);
    if (key === "worktree") {
      if (cur) list.push(cur);
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

// src/index.js
var CHANGED_TOPIC = "git.changed";
var DEBOUNCE_MS = 300;
var LOG_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e";
var META_FORMAT = "--format=%H%x1f%h%x1f%an%x1f%ad%x1f%s";
function parseLog(stdout) {
  const out = [];
  for (const rec of stdout.split("")) {
    const t = rec.trim();
    if (!t) continue;
    const f = t.split("");
    if (f.length !== 5) continue;
    out.push({ hash: f[0], short: f[1], author: f[2], date: f[3], subject: f[4] });
  }
  return out;
}
var index_default = {
  activate(ctx) {
    const app = ctx.app;
    const msg = (en, ko) => (typeof app.locale === "function" ? app.locale() : "en") === "ko" ? ko : en;
    const err = (code, message, extra = {}) => ({ ok: false, code, message, ...extra });
    const runGit = createGitRunner(app.process);
    const resolvePath = (p) => {
      if (typeof p.path === "string" && p.path.trim()) return p.path;
      return app.project?.current?.()?.root ?? null;
    };
    const noPath = () => err("NO_PATH", msg("no project root \u2014 pass path", "\uD504\uB85C\uC81D\uD2B8 \uB8E8\uD2B8 \uC5C6\uC74C \u2014 path \uB97C \uC9C0\uC815\uD558\uC138\uC694"));
    const gitDetail = (r) => r.stderr && r.stderr.trim() || r.stdout && r.stdout.trim() || `git exit ${r.code}`;
    const gitOp = (r) => {
      const a = r.args ?? [];
      return a[0] === "worktree" ? `worktree ${a[1] ?? ""}`.trim() : String(a[0] ?? "git");
    };
    const gitErr = (r) => err(
      "GIT_ERROR",
      msg(
        `git ${gitOp(r)} failed \u2014 git's own account is in detail`,
        `git ${gitOp(r)} \uC2E4\uD328 \u2014 git \uC774 \uB0A8\uAE34 \uC6D0\uBB38\uC740 detail \uC5D0 \uC788\uC2B5\uB2C8\uB2E4`
      ),
      { data: { detail: gitDetail(r) } }
    );
    const watches = /* @__PURE__ */ new Map();
    async function startWatch(root) {
      if (watches.has(root)) return { already: true, root, watching: watches.get(root).dirs };
      const dirs = watchDirs(root);
      const debounced = makeTrailingDebounce(DEBOUNCE_MS, (kinds) => {
        for (const kind of kinds) app.bus.emit(CHANGED_TOPIC, { root, kind });
      });
      const granted = [];
      const disposables = [];
      for (const dir of dirs) {
        const r = await app.commands.execute("fs.watch", { path: dir });
        if (!r.ok) {
          for (const g of granted) await app.commands.execute("fs.unwatch", { path: g });
          for (const d of disposables) d.dispose();
          return err(
            "WATCH_FAILED",
            msg(`cannot watch ${dir}: ${r.message}`, `\uAC10\uC2DC \uC2E4\uD328 ${dir}: ${r.message}`)
          );
        }
        granted.push(dir);
        disposables.push(
          app.fs.watch(dir, (changed) => {
            const kind = classifyChange(root, changed);
            if (kind) debounced(kind);
          })
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
    async function unwatchUnder(dir) {
      for (const root of [...watches.keys()]) {
        if (root === dir || root.startsWith(`${dir}/`)) await stopWatch(root);
      }
    }
    const reg = (name, spec) => ctx.subscriptions.push(app.commands.register(name, spec));
    reg("root", {
      description: "Locate the repository root for a directory. Tri-state result: repo (with root path), not-repo, or error \u2014 an unreadable path or missing git is an error, not not-repo.",
      triggers: { ko: "\uC800\uC7A5\uC18C \uD310\uBCC4 \uB8E8\uD2B8 \uCC3E\uAE30 \uAE43 \uC800\uC7A5\uC18C \uC5EC\uBD80" },
      params: { path: { type: "string", description: "Directory to probe (omit = project root)" } },
      returns: '{ state: "repo"|"not-repo"|"error", root?, error? }',
      examples: [`sok plugin.soksak-plugin-git-core.root '{"path":"/Users/me/work"}'`],
      message: (d) => d.state === "repo" ? msg(`repository: ${d.root}`, `\uC800\uC7A5\uC18C: ${d.root}`) : d.state === "not-repo" ? msg("not a repository", "\uC800\uC7A5\uC18C \uC544\uB2D8") : msg("probe error", "\uD310\uBCC4 \uC624\uB958"),
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
      }
    });
    reg("head", {
      description: "Read what is checked out here: the branch, its commit oid, and whether HEAD is detached. A detached HEAD reports branch:null and detached:true \u2014 it is a state to show, not an error.",
      triggers: { ko: "\uD604\uC7AC \uBE0C\uB79C\uCE58 \uD655\uC778 \uD5E4\uB4DC \uCCB4\uD06C\uC544\uC6C3" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ branch: string|null, oid, detached }",
      examples: ["sok plugin.soksak-plugin-git-core.head"],
      message: (d) => d.detached ? msg(`detached at ${d.oid.slice(0, 7)}`, `\uBD84\uB9AC\uB41C HEAD ${d.oid.slice(0, 7)}`) : msg(`on ${d.branch}`, `${d.branch} \uBE0C\uB79C\uCE58`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const name = await runGit({ cwd: path, args: ["rev-parse", "--abbrev-ref", "HEAD"] });
        if (name.code !== 0) return gitErr(name);
        const oid = await runGit({ cwd: path, args: ["rev-parse", "HEAD"] });
        if (oid.code !== 0) return gitErr(oid);
        const branch = name.stdout.trim();
        const detached = branch === "HEAD";
        return { branch: detached ? null : branch, oid: oid.stdout.trim(), detached };
      }
    });
    reg("init", {
      description: "Run git init with initial branch main when the directory has no .git. Idempotent \u2014 an existing repository is a no-op reported as initialized:false.",
      triggers: { ko: "\uAE43 \uCD08\uAE30\uD654 \uC800\uC7A5\uC18C \uC0DD\uC131 init" },
      params: { path: { type: "string", description: "Directory to initialize (omit = project root)" } },
      returns: "{ initialized, path }",
      examples: [`sok plugin.soksak-plugin-git-core.init '{"path":"/Users/me/work"}'`],
      message: (d) => d.initialized ? msg("initialized", "\uC800\uC7A5\uC18C\uB97C \uCD08\uAE30\uD654\uD588\uC2B5\uB2C8\uB2E4") : msg("already a repository", "\uC774\uBBF8 \uC800\uC7A5\uC18C\uC785\uB2C8\uB2E4"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const probe = await runGit({ cwd: path, args: ["rev-parse", "--show-toplevel"] });
        if (probe.code === 0 && probe.stdout.trim() === path) return { initialized: false, path };
        const r = await runGit({ cwd: path, args: ["init", "-b", "main"], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { initialized: true, path };
      }
    });
    reg("clone", {
      description: "Clone a repository into a validated directory name under the target path. The name derives from the URL (or the dir parameter) and must be a safe slug. Progress lines stream as command progress events.",
      triggers: { ko: "\uC800\uC7A5\uC18C \uBCF5\uC81C \uD074\uB860 \uB0B4\uB824\uBC1B\uAE30" },
      params: {
        url: { type: "string", description: "Clone URL (https/ssh/local path)", required: true },
        path: { type: "string", description: "Parent directory (omit = project root)" },
        dir: { type: "string", description: "Target directory name (default: derived from URL)" },
        branch: { type: "string", description: "Branch to check out" }
      },
      returns: "{ dir: absolute path of the clone }",
      examples: [`sok plugin.soksak-plugin-git-core.clone '{"url":"https://github.com/user/repo.git"}'`],
      message: (d) => msg(`cloned: ${d.dir}`, `\uBCF5\uC81C \uC644\uB8CC: ${d.dir}`),
      handler: async (p) => {
        const parent = resolvePath(p);
        if (!parent) return noPath();
        if (!validCloneUrl(p.url)) {
          return err(
            "INVALID_URL",
            msg(
              "url not allowed \u2014 no credentials in the url (use the credential helper), no option-shaped url",
              "\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 url \u2014 url \uC5D0 \uC790\uACA9\uC99D\uBA85 \uAE08\uC9C0(credential helper \uC0AC\uC6A9), \uC635\uC158 \uD615\uD0DC \uAE08\uC9C0"
            )
          );
        }
        const name = typeof p.dir === "string" && p.dir ? p.dir : repoDirFromUrl(p.url);
        if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
          return err("INVALID_URL", msg("cannot derive a safe directory name from url", "url \uC5D0\uC11C \uC548\uC804\uD55C \uB514\uB809\uD1A0\uB9AC\uBA85\uC744 \uC720\uB3C4\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4"));
        }
        if (typeof p.branch === "string" && p.branch && !validBranchName(p.branch)) {
          return err("INVALID_BRANCH", msg("invalid branch name", "\uBE0C\uB79C\uCE58\uBA85 \uD615\uC2DD \uC704\uBC18"));
        }
        const args = ["clone", "--progress"];
        if (p.branch) args.push("-b", p.branch);
        args.push("--", String(p.url), name);
        const r = await runGit({
          cwd: parent,
          args,
          kind: "write",
          timeoutMs: 6e5,
          onStderrLine: (line) => app.events.progress("clone", { line })
        });
        if (r.code !== 0) return gitErr(r);
        return { dir: `${parent}/${name}` };
      }
    });
    reg("status", {
      description: "Read repository status via porcelain v2 with the branch header: branch name, upstream, ahead/behind, and per-path decoration classes (modified/added/deleted/renamed/untracked/ignored/conflicted). Entries cap at maxEntries with a truncated flag.",
      triggers: { ko: "\uC800\uC7A5\uC18C \uC0C1\uD0DC \uBCC0\uACBD \uD30C\uC77C \uBAA9\uB85D \uC2A4\uD14C\uC774\uD130\uC2A4" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        maxEntries: { type: "number", description: "Entry cap (default 5000)" }
      },
      returns: "{ branch: {oid,head,upstream?,ahead?,behind?}, entries: [{path,x,y,status,origPath?}], truncated }",
      examples: ["sok plugin.soksak-plugin-git-core.status"],
      message: (d) => msg(`${d.entries.length} changed entries`, `\uBCC0\uACBD ${d.entries.length}\uAC74`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const r = await runGit({ cwd: path, args: ["status", "--porcelain=v2", "--branch", "-z"] });
        if (r.code !== 0) return gitErr(r);
        return parseStatusV2(r.stdout, { maxEntries: p.maxEntries });
      }
    });
    reg("watch.start", {
      description: "Start watching a repository for changes: .git and .git/refs/heads (non-recursive, OS events through core fs.watch). Emits the git.changed {root, kind} bus event, kind = meta (HEAD/index) or refs (branch tips). Watch registration failures fail this command \u2014 there is no silent fallback. Idempotent per root.",
      triggers: { ko: "\uC800\uC7A5\uC18C \uBCC0\uACBD \uAC10\uC2DC \uC2DC\uC791 \uC6CC\uCE58" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ root, watching: [dirs] } | { already: true, root, watching }",
      examples: ["sok plugin.soksak-plugin-git-core.watch.start"],
      message: (d) => d.already ? msg("already watching", "\uC774\uBBF8 \uAC10\uC2DC \uC911") : msg(`watching ${d.root}`, `\uAC10\uC2DC \uC2DC\uC791: ${d.root}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const probe = await runGit({ cwd: path, args: ["rev-parse", "--show-toplevel"] });
        if (probe.code !== 0) return gitErr(probe);
        return startWatch(probe.stdout.trim());
      }
    });
    reg("watch.stop", {
      description: "Stop watching a repository and release its core fs.watch subscriptions.",
      triggers: { ko: "\uC800\uC7A5\uC18C \uBCC0\uACBD \uAC10\uC2DC \uC911\uC9C0 \uD574\uC81C" },
      params: { path: { type: "string", description: "Repository root (omit = project root)" } },
      returns: "{ stopped: whether a watch session existed }",
      examples: ["sok plugin.soksak-plugin-git-core.watch.stop"],
      message: (d) => d.stopped ? msg("stopped", "\uAC10\uC2DC\uB97C \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4") : msg("was not watching", "\uAC10\uC2DC \uC911\uC774 \uC544\uB2C8\uC5C8\uC2B5\uB2C8\uB2E4"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        return { stopped: await stopWatch(path) };
      }
    });
    reg("watch.list", {
      description: "List active repository watch sessions \u2014 the observable state of the change-event pipeline (which roots, which directories, since when).",
      triggers: { ko: "\uC800\uC7A5\uC18C \uAC10\uC2DC \uBAA9\uB85D \uC0C1\uD0DC" },
      params: {},
      returns: "{ watches: [{root, dirs, since}] }",
      examples: ["sok plugin.soksak-plugin-git-core.watch.list"],
      message: (d) => msg(`${d.watches.length} watches`, `\uAC10\uC2DC ${d.watches.length}\uAC74`),
      handler: () => ({
        watches: [...watches.values()].map((s) => ({ root: s.root, dirs: s.dirs, since: s.since }))
      })
    });
    reg("branch.exists", {
      description: "Does a local branch exist? The question a consumer must answer before choosing between creating a worktree on a new branch and attaching one to the branch it already has.",
      triggers: { ko: "\uBE0C\uB79C\uCE58 \uC874\uC7AC \uD655\uC778 \uC788\uB294\uC9C0" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        branch: { type: "string", description: "Branch name", required: true }
      },
      returns: "{ exists }",
      examples: [`sok plugin.soksak-plugin-git-core.branch.exists '{"branch":"feat/x"}'`],
      message: (d) => d.exists ? msg("the branch exists", "\uBE0C\uB79C\uCE58\uAC00 \uC788\uC2B5\uB2C8\uB2E4") : msg("no such branch", "\uBE0C\uB79C\uCE58 \uC5C6\uC74C"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const branch = String(p.branch ?? "");
        if (!validBranchName(branch)) return err("INVALID_BRANCH", msg("invalid branch name", "\uBE0C\uB79C\uCE58\uBA85 \uD615\uC2DD \uC704\uBC18"));
        const r = await runGit({ cwd: path, args: ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`] });
        if (r.code === 0) return { exists: true };
        if (r.code === 1) return { exists: false };
        return gitErr(r);
      }
    });
    reg("worktree.add", {
      description: "Add a worktree. By default it creates a NEW branch at base (default HEAD), and records the base in repo config (soksak.worktree.<branch>.base). With attach:true it checks out an EXISTING branch instead \u2014 the reopen path, where the branch survived the last close and carries the work. Default dir is <root>-wt/<branch-slug>, overridable via dir.",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uCD94\uAC00 \uC0DD\uC131 \uBE0C\uB79C\uCE58 \uC791\uC5C5\uD2B8\uB9AC \uC7AC\uBD80\uCC29" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        branch: { type: "string", description: "Branch name \u2014 created, or attached with attach:true", required: true },
        base: { type: "string", description: "Base ref for a new branch (default HEAD); ignored with attach" },
        dir: { type: "string", description: "Worktree directory (default <root>-wt/<branch-slug>)" },
        attach: { type: "boolean", description: "Check out the existing branch instead of creating it", default: false }
      },
      returns: "{ dir, branch, base, attached }",
      examples: [
        `sok plugin.soksak-plugin-git-core.worktree.add '{"branch":"feat/x"}'`,
        `sok plugin.soksak-plugin-git-core.worktree.add '{"branch":"feat/x","attach":true}'`
      ],
      message: (d) => d.attached ? msg(`attached ${d.branch} at ${d.dir}`, `${d.branch} \uC7AC\uBD80\uCC29: ${d.dir}`) : msg(`worktree at ${d.dir}`, `\uC6CC\uD06C\uD2B8\uB9AC \uC0DD\uC131: ${d.dir}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const branch = String(p.branch ?? "");
        if (!validBranchName(branch)) return err("INVALID_BRANCH", msg("invalid branch name", "\uBE0C\uB79C\uCE58\uBA85 \uD615\uC2DD \uC704\uBC18"));
        const attach = p.attach === true;
        const base = typeof p.base === "string" && p.base ? p.base : "HEAD";
        if (!attach && base !== "HEAD" && !validRef(base)) {
          return err("INVALID_REF", msg("invalid base ref", "base \uCC38\uC870 \uD615\uC2DD \uC704\uBC18"));
        }
        const dir = typeof p.dir === "string" && p.dir ? p.dir : `${path}-wt/${branch.replaceAll("/", "-")}`;
        const args = attach ? ["worktree", "add", "--", dir, branch] : ["worktree", "add", "--no-track", "-b", branch, "--", dir, base];
        const r = await runGit({ cwd: path, args, kind: "write" });
        if (r.code !== 0) return gitErr(r);
        if (attach) return { dir, branch, base: null, attached: true };
        await runGit({ cwd: path, args: ["config", `soksak.worktree.${branch}.base`, base], kind: "write" });
        return { dir, branch, base, attached: false };
      }
    });
    reg("worktree.list", {
      description: "List worktrees (porcelain): path, HEAD, branch, and bare/detached/locked/prunable attributes.",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uBAA9\uB85D \uC870\uD68C" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ worktrees: [{path, head?, branch?, bare?, detached?, locked?, prunable?}] }",
      examples: ["sok plugin.soksak-plugin-git-core.worktree.list"],
      message: (d) => msg(`${d.worktrees.length} worktrees`, `\uC6CC\uD06C\uD2B8\uB9AC ${d.worktrees.length}\uAC1C`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const r = await runGit({ cwd: path, args: ["worktree", "list", "--porcelain", "-z"] });
        if (r.code !== 0) return gitErr(r);
        return { worktrees: parseWorktreeList(r.stdout) };
      }
    });
    reg("worktree.remove", {
      description: "Remove a worktree. Refuses when the worktree has uncommitted changes (git's unmerged protection) \u2014 use worktree.remove.force for that, deliberately. Watch sessions under the tree are released before removal.",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uC81C\uAC70 \uC0AD\uC81C" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        dir: { type: "string", description: "Worktree directory to remove", required: true }
      },
      returns: "{ removed: dir }",
      examples: [`sok plugin.soksak-plugin-git-core.worktree.remove '{"dir":"/w/repo-wt/feat-x"}'`],
      message: (d) => msg(`removed ${d.removed}`, `\uC6CC\uD06C\uD2B8\uB9AC \uC81C\uAC70: ${d.removed}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const dir = String(p.dir ?? "");
        await unwatchUnder(dir);
        const r = await runGit({ cwd: path, args: ["worktree", "remove", "--", dir], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { removed: dir };
      }
    });
    reg("worktree.remove.force", {
      danger: "destructive",
      description: "Force-remove a worktree, discarding its uncommitted changes. Separate from worktree.remove so the destructive path is an explicit, gated choice.",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uAC15\uC81C \uC81C\uAC70 \uC0AD\uC81C" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        dir: { type: "string", description: "Worktree directory to remove", required: true }
      },
      returns: "{ removed: dir }",
      examples: [`sok plugin.soksak-plugin-git-core.worktree.remove.force '{"dir":"/w/repo-wt/feat-x"}'`],
      message: (d) => msg(`force-removed ${d.removed}`, `\uC6CC\uD06C\uD2B8\uB9AC \uAC15\uC81C \uC81C\uAC70: ${d.removed}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const dir = String(p.dir ?? "");
        await unwatchUnder(dir);
        const r = await runGit({ cwd: path, args: ["worktree", "remove", "--force", "--", dir], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { removed: dir };
      }
    });
    reg("worktree.prune", {
      description: "Prune stale worktree bookkeeping (removed directories, broken links).",
      triggers: { ko: "\uC6CC\uD06C\uD2B8\uB9AC \uC815\uB9AC \uD504\uB8EC" },
      params: { path: { type: "string", description: "Repository directory (omit = project root)" } },
      returns: "{ done: true }",
      examples: ["sok plugin.soksak-plugin-git-core.worktree.prune"],
      message: () => msg("pruned", "\uC815\uB9AC\uD588\uC2B5\uB2C8\uB2E4"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const r = await runGit({ cwd: path, args: ["worktree", "prune"], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { done: true };
      }
    });
    const badPath = (f) => err("INVALID_PATH", msg(`not a repository-relative path: ${f}`, `\uC800\uC7A5\uC18C \uC0C1\uB300 \uACBD\uB85C\uAC00 \uC544\uB2D8: ${f}`));
    const requireFiles = (p) => {
      const files = Array.isArray(p.files) ? p.files.map(String) : [];
      if (files.length === 0) return { error: err("NO_FILES", msg("files required", "files \uD544\uC694")) };
      for (const f of files) {
        if (!validPath(f)) return { error: badPath(f) };
      }
      return { files };
    };
    reg("stage", {
      danger: "destructive",
      description: "Stage files into the index (git add -- <files>). Files are repository-relative paths.",
      triggers: { ko: "\uC2A4\uD14C\uC774\uC9C0 \uCD94\uAC00 \uBCC0\uACBD \uB2F4\uAE30" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        files: { type: "array", description: "Repository-relative paths", required: true }
      },
      returns: "{ staged: [files] }",
      examples: [`sok plugin.soksak-plugin-git-core.stage '{"files":["src/a.ts"]}'`],
      message: (d) => msg(`staged ${d.staged.length} files`, `${d.staged.length}\uAC1C \uD30C\uC77C \uC2A4\uD14C\uC774\uC9C0`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const picked = requireFiles(p);
        if (picked.error) return picked.error;
        const files = picked.files;
        const r = await runGit({ cwd: path, args: ["add", "--", ...files], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { staged: files };
      }
    });
    reg("unstage", {
      danger: "destructive",
      description: "Remove files from the index without touching the working tree (git restore --staged -- <files>).",
      triggers: { ko: "\uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C \uBE7C\uAE30" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        files: { type: "array", description: "Repository-relative paths", required: true }
      },
      returns: "{ unstaged: [files] }",
      examples: [`sok plugin.soksak-plugin-git-core.unstage '{"files":["src/a.ts"]}'`],
      message: (d) => msg(`unstaged ${d.unstaged.length} files`, `${d.unstaged.length}\uAC1C \uD30C\uC77C \uC2A4\uD14C\uC774\uC9C0 \uD574\uC81C`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const picked = requireFiles(p);
        if (picked.error) return picked.error;
        const files = picked.files;
        const r = await runGit({ cwd: path, args: ["restore", "--staged", "--", ...files], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        return { unstaged: files };
      }
    });
    reg("commit", {
      danger: "destructive",
      description: "Create a commit from the staged index with the given message. Identity comes from the repository/user git config; a missing identity fails with git's own guidance.",
      triggers: { ko: "\uCEE4\uBC0B \uC0DD\uC131 \uC800\uC7A5" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        message: { type: "string", description: "Commit message", required: true }
      },
      returns: "{ oid, subject }",
      examples: [`sok plugin.soksak-plugin-git-core.commit '{"message":"Add feature"}'`],
      message: (d) => msg(`committed ${d.oid.slice(0, 7)}`, `\uCEE4\uBC0B \uC644\uB8CC ${d.oid.slice(0, 7)}`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const message = String(p.message ?? "").trim();
        if (!message) return err("NO_MESSAGE", msg("commit message required", "\uCEE4\uBC0B \uBA54\uC2DC\uC9C0 \uD544\uC694"));
        const r = await runGit({ cwd: path, args: ["commit", "-m", message], kind: "write" });
        if (r.code !== 0) return gitErr(r);
        const head = await runGit({ cwd: path, args: ["rev-parse", "HEAD"] });
        return { oid: head.stdout.trim(), subject: message.split("\n")[0] };
      }
    });
    reg("discard", {
      danger: "destructive",
      description: "Discard working-tree changes for tracked files (git restore --staged --worktree). With untracked:true also deletes the listed untracked files \u2014 every path must prove it stays inside the repository (relative, no escape) or the whole command refuses.",
      triggers: { ko: "\uBCC0\uACBD \uD30C\uAE30 \uB418\uB3CC\uB9AC\uAE30 \uC0AD\uC81C" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        files: { type: "array", description: "Repository-relative paths", required: true },
        untracked: { type: "boolean", description: "Also delete listed untracked files", default: false }
      },
      returns: "{ discarded: [files] }",
      examples: [`sok plugin.soksak-plugin-git-core.discard '{"files":["src/a.ts"]}'`],
      message: (d) => msg(`discarded ${d.discarded.length} files`, `${d.discarded.length}\uAC1C \uD30C\uC77C \uD30C\uAE30`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const picked = requireFiles(p);
        if (picked.error) return picked.error;
        const files = picked.files;
        if (p.untracked === true) {
          const r2 = await runGit({ cwd: path, args: ["clean", "-f", "--", ...files], kind: "write" });
          if (r2.code !== 0) return gitErr(r2);
          return { discarded: files };
        }
        const r = await runGit({
          cwd: path,
          args: ["restore", "--staged", "--worktree", "--", ...files],
          kind: "write"
        });
        if (r.code !== 0) return gitErr(r);
        return { discarded: files };
      }
    });
    reg("log", {
      description: "Read commit history in reverse-chronological order. Pagination via limit (default 50, max 500) and skip.",
      triggers: { ko: "\uCEE4\uBC0B \uC774\uB825 \uB85C\uADF8 \uD788\uC2A4\uD1A0\uB9AC" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        limit: { type: "number", description: "Maximum commits (default 50, max 500)" },
        skip: { type: "number", description: "Commits to skip for pagination" }
      },
      returns: "{ commits: [{hash, short, author, date, subject}] }",
      examples: ["sok plugin.soksak-plugin-git-core.log", `sok plugin.soksak-plugin-git-core.log '{"limit":10}'`],
      message: (d) => msg(`${d.commits.length} commits`, `\uCEE4\uBC0B ${d.commits.length}\uAC74`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const limit = String(Math.min(Number(p.limit) || 50, 500));
        const skip = String(Number(p.skip) || 0);
        const r = await runGit({
          cwd: path,
          args: ["log", "--date=iso", LOG_FORMAT, "-n", limit, "--skip", skip]
        });
        if (r.code !== 0) return gitErr(r);
        return { commits: parseLog(r.stdout) };
      }
    });
    reg("show", {
      description: "Show one commit in full: metadata, changed file list (status + path), and the raw patch. The ref passes the commit whitelist (hex 4-40, HEAD forms).",
      triggers: { ko: "\uCEE4\uBC0B \uC0C1\uC138 \uD655\uC778 \uD328\uCE58" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        commit: { type: "string", description: "Commit hash (4-40 hex) or HEAD/HEAD~N/HEAD^", required: true }
      },
      returns: "{ meta, files: [{status, path}], patch }",
      examples: [`sok plugin.soksak-plugin-git-core.show '{"commit":"HEAD"}'`],
      message: (d) => msg(`${d.files.length} files changed`, `\uBCC0\uACBD \uD30C\uC77C ${d.files.length}\uAC1C`),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        const commit = String(p.commit ?? "");
        if (!sanitizeCommit(commit)) return err("INVALID_REF", msg("ref not allowed", "\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 \uCEE4\uBC0B \uCC38\uC870"));
        const head = await runGit({
          cwd: path,
          args: ["show", commit, "--date=iso", META_FORMAT, "--name-status"]
        });
        if (head.code !== 0) return gitErr(head);
        const lines = head.stdout.split("\n").filter((l) => l.trim());
        const meta = parseLog(`${lines[0] ?? ""}`)[0];
        if (!meta) return err("GIT_ERROR", msg("cannot parse commit meta", "\uCEE4\uBC0B \uBA54\uD0C0 \uD30C\uC2F1 \uC2E4\uD328"));
        const files = [];
        for (const line of lines.slice(1)) {
          const cols = line.split("	");
          if (cols.length < 2) continue;
          files.push({ status: cols[0][0] ?? "", path: cols[cols.length - 1] });
        }
        const patch = await runGit({ cwd: path, args: ["show", commit, "--format=", "--patch"] });
        if (patch.code !== 0) return gitErr(patch);
        return { meta, files, patch: patch.stdout };
      }
    });
    reg("diff", {
      description: "Return the raw unified diff: the working tree by default, the index with staged:true, or one commit's patch with commit. Optional file narrows the diff behind the -- path boundary.",
      triggers: { ko: "\uBCC0\uACBD \uBE44\uAD50 diff \uCC28\uC774" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        file: { type: "string", description: "Limit to this repository-relative path" },
        commit: { type: "string", description: "Commit hash or HEAD form" },
        staged: { type: "boolean", description: "Diff the index instead of the working tree", default: false }
      },
      returns: "{ diff: unified diff text }",
      examples: ["sok plugin.soksak-plugin-git-core.diff", `sok plugin.soksak-plugin-git-core.diff '{"staged":true}'`],
      message: (d) => String(d.diff ?? "").trim() ? msg("changes found", "\uBCC0\uACBD \uC788\uC74C") : msg("no changes", "\uBCC0\uACBD \uC5C6\uC74C"),
      handler: async (p) => {
        const path = resolvePath(p);
        if (!path) return noPath();
        let args;
        if (typeof p.commit === "string" && p.commit) {
          if (!sanitizeCommit(p.commit)) return err("INVALID_REF", msg("ref not allowed", "\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 \uCEE4\uBC0B \uCC38\uC870"));
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
      }
    });
    async function resolveBase(path, raw) {
      if (typeof raw === "string" && raw) return validRef(raw) ? raw : false;
      for (const b of ["main", "master"]) {
        const r = await runGit({ cwd: path, args: ["show-ref", "--verify", "--quiet", `refs/heads/${b}`] });
        if (r.code === 0) return b;
      }
      return null;
    }
    const noBase = () => err("NO_BASE", msg("no default branch \u2014 pass base", "\uAE30\uBCF8 \uBE0C\uB79C\uCE58 \uC5C6\uC74C \u2014 base \uB97C \uC9C0\uC815\uD558\uC138\uC694"));
    const badRef = () => err("INVALID_REF", msg("ref not allowed", "\uD5C8\uC6A9\uB418\uC9C0 \uC54A\uB294 \uCC38\uC870"));
    reg("diff.files", {
      description: "List what a branch changed since it diverged: the three-dot range base...target. Each file carries its status and its line counts; a binary file reports binary:true with null counts rather than pretending nothing changed.",
      triggers: { ko: "\uBE0C\uB79C\uCE58 \uBCC0\uACBD \uD30C\uC77C \uBAA9\uB85D \uB9AC\uBDF0 \uB300\uC0C1 \uBE44\uAD50" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        base: { type: "string", description: "Base ref (omit = the local default branch)" },
        target: { type: "string", description: "Branch or commit under review", required: true }
      },
      returns: "{ base, target, files: [{path, status, oldPath?, added, deleted, binary}] }",
      examples: [`sok plugin.soksak-plugin-git-core.diff.files '{"target":"feat/x"}'`],
      message: (d) => msg(`${d.files.length} files changed`, `\uBCC0\uACBD \uD30C\uC77C ${d.files.length}\uAC1C`),
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
      }
    });
    reg("diff.range", {
      description: "The unified diff of the three-dot range base...target, optionally narrowed to one file behind the -- path boundary. The two-point diff command answers about the working tree; this one answers about a branch.",
      triggers: { ko: "\uBE0C\uB79C\uCE58 \uBCC0\uACBD \uB0B4\uC6A9 \uBE44\uAD50 \uB9AC\uBDF0 diff" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        base: { type: "string", description: "Base ref (omit = the local default branch)" },
        target: { type: "string", description: "Branch or commit under review", required: true },
        file: { type: "string", description: "Limit to this repository-relative path" }
      },
      returns: "{ base, target, diff }",
      examples: [`sok plugin.soksak-plugin-git-core.diff.range '{"target":"feat/x","file":"src/a.ts"}'`],
      message: (d) => d.diff.trim() ? msg("changes found", "\uBCC0\uACBD \uC788\uC74C") : msg("no changes", "\uBCC0\uACBD \uC5C6\uC74C"),
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
      }
    });
    reg("merge", {
      danger: "destructive",
      description: "Merge a branch into what is checked out here. Defaults to --no-ff so the branch stays visible in the history instead of being fast-forwarded out of existence. A conflict is reported with git's own text and left exactly as git left it \u2014 this command never auto-resolves, auto-aborts, or auto-commits its way out.",
      triggers: { ko: "\uBE0C\uB79C\uCE58 \uBA38\uC9C0 \uBCD1\uD569 \uD569\uCE58\uAE30" },
      params: {
        path: { type: "string", description: "Repository directory (omit = project root)" },
        target: { type: "string", description: "Branch or commit to merge in", required: true },
        noFf: { type: "boolean", description: "Keep the merge commit (default true)", default: true }
      },
      returns: "{ oid }",
      examples: [`sok plugin.soksak-plugin-git-core.merge '{"target":"feat/x"}'`],
      message: (d) => msg(`merged at ${d.oid.slice(0, 7)}`, `\uBA38\uC9C0 \uC644\uB8CC ${d.oid.slice(0, 7)}`),
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
      }
    });
  },
  deactivate() {
  }
};
export {
  index_default as default
};
