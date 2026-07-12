// 테스트용 호스트 app — activate 를 앱 없이 구동한다(코어 소스 비의존, api 동형 부분집합).
// process 는 주입(기록형/실행형), fs.watch·bus.emit·commands.execute 는 기록 + 시뮬레이션 훅.
export function mockApp(opts = {}) {
  const registered = new Map();
  const busEvents = [];
  const watchCalls = []; // { kind: "api-watch"|"api-unwatch"|"cmd", name?, dir }
  const watchers = new Map(); // dir → Set<cb>
  const progress = [];

  const app = {
    locale: () => opts.locale ?? "en",
    project: { current: () => opts.project ?? null },
    commands: {
      register(name, spec) {
        registered.set(name, spec);
        return { dispose() {} };
      },
      async execute(name, params) {
        watchCalls.push({ kind: "cmd", name, dir: params?.path });
        if (opts.executeCommand) return opts.executeCommand(name, params);
        return { ok: true, code: "OK", message: "", data: { path: params?.path, watchers: 1 } };
      },
    },
    events: {
      on: () => ({ dispose() {} }),
      progress: (command, delta) => progress.push({ command, delta }),
    },
    bus: {
      emit: (topic, payload) => busEvents.push({ topic, payload }),
      on: () => ({ dispose() {} }),
    },
    fs: {
      watch(dir, cb) {
        watchCalls.push({ kind: "api-watch", dir });
        if (!watchers.has(dir)) watchers.set(dir, new Set());
        watchers.get(dir).add(cb);
        return {
          dispose() {
            watchCalls.push({ kind: "api-unwatch", dir });
            watchers.get(dir)?.delete(cb);
          },
        };
      },
    },
    process: opts.process,
    activity: { publish: () => {} },
  };

  const ctx = { app, manifest: opts.manifest ?? {}, subscriptions: [] };
  const fireFsChange = (dir) => {
    for (const cb of watchers.get(dir) ?? []) cb(dir);
  };
  return { app, ctx, registered, busEvents, watchCalls, progress, fireFsChange };
}
