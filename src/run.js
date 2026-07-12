// git 러너 — process 표면 주입형(런타임=app.process, 테스트=node adapter).
// 규약(convention.js)의 유일한 시행 지점: 전 스폰이 여기서 env·timeout 을 받는다.
import { envFor, timeoutFor } from "./convention.js";

// runGit({cwd, args, kind, timeoutMs?, onStderrLine?}) → {code, stdout, stderr}
// 비정상 종료를 여기서 에러로 바꾸지 않는다 — 판정(tri-state 등)은 호출자 소유.
export function createGitRunner(processApi) {
  return function runGit({ cwd, args, kind = "read", timeoutMs, onStderrLine }) {
    return new Promise((resolve, reject) => {
      const limit = timeoutMs ?? timeoutFor(kind);
      const dec = new TextDecoder();
      let out = "";
      let err = "";
      let errLine = "";
      let done = false;
      let timer = null;
      processApi
        .spawn("git", args, { cwd, env: envFor(kind) })
        .then((handle) => {
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
              finish(resolve, { code, stdout: out, stderr: err.trim() });
            }),
          );
        })
        .catch((e) => {
          if (!done) {
            done = true;
            if (timer) clearTimeout(timer);
            reject(e instanceof Error ? e : new Error(String(e)));
          }
        });
    });
  };
}
