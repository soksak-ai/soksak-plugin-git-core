// soksak-plugin-git-core 번들 빌드 — esbuild 단일 ESM main.js.
// 코어 로더는 진입 코드를 blob URL 로 import 한다(loader.ts) — blob URL 은 상대 import
// (./convention.js 등)를 해소하지 못하므로 여러 파일 진입은 단일 파일로 번들해야 한다.
import { build, context } from "esbuild";

const opts = {
  entryPoints: ["src/index.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  outfile: "main.js",
  minify: false,
  legalComments: "none",
  logLevel: "info",
};

if (process.argv.includes("--watch")) {
  const ctx = await context(opts);
  await ctx.watch();
  console.log("[git-core] watching src → main.js …");
} else {
  await build(opts);
  console.log("[git-core] built main.js");
}
