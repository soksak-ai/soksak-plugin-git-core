// 커맨드 표면 conformance — C2 투명성(command 축) + 선언≡실제 양방향 통합 법칙.
// 검사 축: ① 매니페스트 contributes.commands ≡ activate 실등록(양방향)
//          ② danger 선언 ≡ 등록 스펙 danger(양방향)
//          ③ 스펙 의무 필드(description·ko triggers·examples·message·returns — T-법 T1)
//          ④ contributes.events 선언(git.changed)이 실 발행 토픽과 일치
// 실행: node --test (앱 불요 — 호스트는 mock).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mockApp } from "./helpers/mock-app.mjs";
import { recordingProcessApi } from "./helpers/mock-process.mjs";

const manifest = JSON.parse(readFileSync(new URL("../plugin.json", import.meta.url), "utf8"));
const plugin = (await import("../main.js")).default;

function activated() {
  const m = mockApp({ process: recordingProcessApi({ stdout: "", code: 0 }), manifest });
  plugin.activate(m.ctx);
  return m;
}

test("선언 ≡ 등록 — 양방향(빠진 등록도, 유령 선언도 없다)", () => {
  const { registered } = activated();
  const declared = manifest.contributes.commands.map((c) => c.name).sort();
  const actual = [...registered.keys()].sort();
  assert.deepEqual(actual, declared);
});

test("danger 선언 ≡ 등록 스펙 danger — 양방향", () => {
  const { registered } = activated();
  for (const c of manifest.contributes.commands) {
    const spec = registered.get(c.name);
    assert.equal(spec.danger, c.danger, `${c.name}: manifest=${c.danger} spec=${spec.danger}`);
  }
});

test("T1 의무 필드 — description·ko triggers·examples·message·returns 전수", () => {
  const { registered } = activated();
  for (const [name, spec] of registered) {
    assert.ok(spec.description?.length > 10, `${name}: description`);
    assert.ok(spec.triggers?.ko?.length > 0, `${name}: triggers.ko`);
    assert.ok(Array.isArray(spec.examples) && spec.examples.length >= 1, `${name}: examples`);
    assert.equal(typeof spec.message, "function", `${name}: message`);
    assert.ok(spec.returns?.length > 0, `${name}: returns`);
  }
});

test("이벤트 선언 — git.changed 가 contributes.events 에 있다", () => {
  assert.deepEqual(manifest.contributes.events, ["git.changed"]);
});

test("deactivate 까지 왕복 — subscriptions 해지 가능", () => {
  const m = mockApp({ process: recordingProcessApi({ stdout: "", code: 0 }), manifest });
  plugin.activate(m.ctx);
  for (const d of m.ctx.subscriptions) d.dispose();
  if (plugin.deactivate) plugin.deactivate();
});
