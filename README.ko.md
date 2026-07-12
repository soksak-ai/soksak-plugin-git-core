# soksak-plugin-git-core

soksak 의 git 라이브러리 플러그인. git 실행 규약과 저장소 프리미티브의
단일진실입니다. 코어 앱은 git 지식을 갖지 않습니다 — 이 플러그인은 generic
코어 표면만 사용합니다: `process`(스폰), `fs.watch`/`fs.unwatch`(경로 감시),
플러그인 버스(이벤트).

이 플러그인은 **`soksak-git-spec@1` 의 구현체**입니다(매니페스트 `implements`).
커맨드 이름·인자·응답·거부 코드와 아래 실행 규약은 이 플러그인이 아니라 계약이
정합니다. 계약 전문과 적합성을 채점하는 시험은 `soksak-contract-git` 에 있습니다.
소비자는 이 플러그인을 이름이 아니라 계약 id 로 찾습니다
(`sok plugin.implementers '{"contract":"soksak-git-spec@1"}'`).

## 실행 규약 (src/convention.js)

- 모든 스폰이 `LC_ALL=C` / `LANG=C` 를 고정합니다 — 호스트 locale 에 출력이
  흔들리지 않습니다. 읽기에는 `GIT_OPTIONAL_LOCKS=0` — 조회가 잠금 파일을
  만들지 않습니다.
- 기계 파싱은 porcelain + `-z` 만. stderr 문구는 파싱하지 않으며, 재가된
  예외는 하나입니다: `root` tri-state 의 `not a git repository` 판별
  (`NOT_REPO_RE`, 단일 정의 — 고정 locale 에서 안정).
- ref 는 화이트리스트(hex 4~40, `HEAD`, `HEAD^`, `HEAD~N`), 브랜치명은
  보수적 ref-format 부분집합, 경로는 `--` 경계 뒤.
- 쓰기 timeout 180s, 읽기 30s, clone 600s(progress 스트림).

## 커맨드 사다리

| 층 | 커맨드 |
|---|---|
| L0 발견 | `root`(tri-state: repo / not-repo / error), `head`(브랜치·oid·detached), `init`(멱등, `-b main`), `clone`(대상명 검증·progress) |
| L1 상태 | `status`(porcelain v2 `--branch`: 브랜치·upstream·ahead/behind·데코레이션 분류·`truncated` 상한), `watch.start` / `watch.stop` / `watch.list` |
| L2 읽기 | `log`, `show`, `diff`(작업트리 / index / 단일 커밋), `diff.files`·`diff.range`(삼점 `base...target` — 브랜치가 갈라진 뒤 한 일) |
| L2 브랜치·워크트리 | `branch.exists`, `worktree.add`(`base` 에서 새 브랜치 생성, base 를 `soksak.worktree.<branch>.base` 로 박제. `attach:true` 는 기존 브랜치를 체크아웃), `worktree.list`, `worktree.remove`(더러운 트리 거부), `worktree.remove.force`(destructive), `worktree.prune` |
| L3 쓰기 | `stage`, `unstage`, `commit`, `discard`, `merge` — 전부 destructive 선언. `discard` 는 전 경로가 repo 내부임을 증명해야만 untracked 파일을 삭제. `merge` 는 `--no-ff` 기본이며 충돌은 git 이 남긴 그대로 둡니다 |

모든 커맨드는 `sok plugin.soksak-plugin-git-core.<name>` 으로 실행합니다.
`path` 는 활성 프로젝트 루트로 폴백합니다.

## git.changed 이벤트

`watch.start` 는 코어 `fs.watch` 를 `<root>/.git` 과 `<root>/.git/refs/heads`
에 등록(비재귀·OS 이벤트·폴링 0)하고, 버스 이벤트
`git.changed { root, kind }` 를 발행합니다 — `kind` 는 `meta`(HEAD·index·병합
상태) 또는 `refs`(브랜치 팁). 감시 등록 실패는 커맨드 실패입니다 — 무음
폴백은 없고, `watch.list` 가 살아있는 세션을 노출합니다. 삭제 경로는
unwatch-before-delete 계약을 지킵니다: `worktree.remove[.force]` 는 삭제 전에
그 트리 아래 감시를 해제합니다.

알려진 잔여: 코어 `fs-change` 이벤트는 변경된 디렉토리만 싣기 때문에 파일명
단위 필터(`*.lock`, `FETCH_HEAD`)는 아직 불가합니다 — 트레일링 디바운스가
잠금 파일 연발을 합치는 것으로 갈음합니다. 해소에는 코어 이벤트가 변경
파일명을 싣는 판올림이 필요하며, 무언 폐기가 아니라 후속 항목으로
추적합니다.

## 테스트

```
npm test   # node --test — 앱 불요. 실 git 픽스처는 ~/.soksak-e2e/git-core
```
