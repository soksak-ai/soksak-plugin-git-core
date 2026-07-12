# soksak-plugin-git-core

Git library plugin for soksak. Single source of truth for the git execution
convention and repository primitives. The core app keeps no git knowledge —
this plugin talks to generic core surfaces only: `process` (spawn),
`fs.watch`/`fs.unwatch` (path-level watch), and the plugin bus (events).

## Execution convention (src/convention.js)

- Every spawn pins `LC_ALL=C` / `LANG=C` — output never varies with the host
  locale. Reads add `GIT_OPTIONAL_LOCKS=0` so queries never create lock files.
- Machine parsing uses porcelain formats with `-z` only. stderr wording is
  never parsed, with one sanctioned exception: the `root` tri-state uses the
  `not a git repository` sentinel, stable under the pinned locale
  (`NOT_REPO_RE`, single definition).
- Refs pass a whitelist (hex 4–40, `HEAD`, `HEAD^`, `HEAD~N`); branch names a
  conservative ref-format subset; paths sit behind `--` boundaries.
- Write commands time out at 180s, reads at 30s, clone at 600s with progress.

## Command ladder

| Layer | Commands |
|---|---|
| L0 discovery | `root` (tri-state: repo / not-repo / error), `init` (idempotent, `-b main`), `clone` (validated target name, progress events) |
| L1 status | `status` (porcelain v2 `--branch`: branch, upstream, ahead/behind, decoration classes, `truncated` cap), `watch.start` / `watch.stop` / `watch.list` |
| L2 worktree | `worktree.add` (`--no-track -b`, base recorded as `soksak.worktree.<branch>.base`), `worktree.list`, `worktree.remove` (refuses dirty trees), `worktree.remove.force` (destructive), `worktree.prune` |
| L3 write | `stage`, `unstage`, `commit`, `discard` — all declared destructive; `discard` deletes untracked files only after every path proves it stays inside the repository |

All commands run as `sok plugin.soksak-plugin-git-core.<name>`. `path` defaults
to the active project root. The read trio `log` / `show` / `diff` mirrors the
legacy core surface so consumer plugins can rewire without behavior change.

## git.changed event

`watch.start` registers core `fs.watch` on `<root>/.git` and
`<root>/.git/refs/heads` (non-recursive, OS events, no polling) and emits the
`git.changed { root, kind }` bus event — `kind` is `meta` (HEAD, index, merge
state) or `refs` (branch tips). Watch registration failures fail the command;
there is no silent fallback, and `watch.list` exposes the live sessions.
Removal paths honor unwatch-before-delete: `worktree.remove[.force]` releases
watch sessions under the tree before deleting it.

Known residual: the core `fs-change` event carries the changed directory only,
so name-level filtering (`*.lock`, `FETCH_HEAD`) is not possible yet; a
trailing debounce coalesces lock churn instead. Lifting this requires the core
event to carry changed file names — tracked as a follow-up, not silently
dropped.

## Tests

```
npm test   # node --test — no app required; real-git fixtures under ~/.soksak-e2e/git-core
```
