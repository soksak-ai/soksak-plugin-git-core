// 테스트용 process 표면 2종.
//   recordingProcessApi = 스폰을 기록하고 준비된 출력을 재생(규약·순서 검사용).
//   nodeProcessApi      = node:child_process 로 app.process 와 동형 구현(실 git 통합 검사용).
// app.process 와 같은 인터페이스: spawn/onData/onStderr/onExit/kill — 리스너 등록 전
// 도착분 버퍼(유실 0) 동작까지 동형.
import { spawn as nodeSpawn } from "node:child_process";

export function recordingProcessApi(replies) {
  const list = Array.isArray(replies) ? [...replies] : null;
  const calls = [];
  const procs = new Map();
  let seq = 0;
  const api = {
    async spawn(cmd, args, opts) {
      const reply = list ? (list.shift() ?? { stdout: "", code: 0 }) : replies;
      const id = ++seq;
      calls.push({ cmd, args, opts: opts ?? {} });
      procs.set(id, reply);
      return id;
    },
    onData(handle, cb) {
      const r = procs.get(handle);
      if (r?.stdout) queueMicrotask(() => cb(new TextEncoder().encode(r.stdout)));
      return { dispose() {} };
    },
    onStderr(handle, cb) {
      const r = procs.get(handle);
      if (r?.stderr) queueMicrotask(() => cb(new TextEncoder().encode(r.stderr)));
      return { dispose() {} };
    },
    onExit(handle, cb) {
      const r = procs.get(handle);
      queueMicrotask(() => queueMicrotask(() => cb(r?.code ?? 0)));
      return { dispose() {} };
    },
    async kill(handle) {
      procs.delete(handle);
    },
  };
  return { api, calls };
}

export function nodeProcessApi() {
  const procs = new Map();
  let seq = 0;
  return {
    async spawn(cmd, args, opts) {
      const id = ++seq;
      const child = nodeSpawn(cmd, args, {
        cwd: opts?.cwd,
        env: { ...process.env, ...(opts?.env ?? {}) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      // app.process 동형: 스폰 실패(잘못된 cwd·미설치 실행물)는 spawn 프라미스 거부.
      await new Promise((res, rej) => {
        child.once("spawn", res);
        child.once("error", rej);
      });
      const st = { child, stdout: [], stderr: [], exit: null, listeners: { out: [], err: [], exit: [] } };
      child.stdout.on("data", (b) => {
        if (st.listeners.out.length) st.listeners.out.forEach((f) => f(new Uint8Array(b)));
        else st.stdout.push(new Uint8Array(b));
      });
      child.stderr.on("data", (b) => {
        if (st.listeners.err.length) st.listeners.err.forEach((f) => f(new Uint8Array(b)));
        else st.stderr.push(new Uint8Array(b));
      });
      child.on("close", (code) => {
        st.exit = code ?? 0;
        st.listeners.exit.forEach((f) => f(st.exit));
      });
      procs.set(id, st);
      return id;
    },
    onData(handle, cb) {
      const st = procs.get(handle);
      if (!st) return { dispose() {} };
      for (const b of st.stdout.splice(0)) cb(b);
      st.listeners.out.push(cb);
      return { dispose() {} };
    },
    onStderr(handle, cb) {
      const st = procs.get(handle);
      if (!st) return { dispose() {} };
      for (const b of st.stderr.splice(0)) cb(b);
      st.listeners.err.push(cb);
      return { dispose() {} };
    },
    onExit(handle, cb) {
      const st = procs.get(handle);
      if (!st) return { dispose() {} };
      if (st.exit !== null) cb(st.exit);
      else st.listeners.exit.push(cb);
      return { dispose() {} };
    },
    async kill(handle) {
      procs.get(handle)?.child.kill("SIGKILL");
    },
  };
}
