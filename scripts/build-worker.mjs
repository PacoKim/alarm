/**
 * Cloudflare Pages 고급 모드용 번들.
 *
 * Pages는 배포 폴더 루트의 `_worker.js` 를 모든 요청의 처리기로 쓰고,
 * 같은 폴더의 나머지 파일은 정적 자원으로 올려 env.ASSETS 로 꺼내 쓴다.
 * (`_worker.js` 자체는 정적 자원으로 노출되지 않는다.)
 *
 * 출력 폴더를 public/ 으로 두어 정적 파일을 복사하지 않고 그대로 쓴다.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { stat } from "node:fs/promises";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outfile = path.join(root, "public/_worker.js");

const result = await build({
  entryPoints: [path.join(root, "src/index.ts")],
  outfile,
  bundle: true,
  format: "esm",
  target: "es2022",
  platform: "neutral",
  mainFields: ["module", "main"],
  conditions: ["workerd", "worker", "browser", "import"],
  minify: true,
  logLevel: "warning",
});

if (result.errors.length) {
  console.error(result.errors);
  process.exit(1);
}

const { size } = await stat(outfile);
console.log(`public/_worker.js  ${(size / 1024).toFixed(1)} KB`);
