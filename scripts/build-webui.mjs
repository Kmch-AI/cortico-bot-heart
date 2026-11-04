/**
 * 打包 Persona / Memory 页的浏览器产物。
 */
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(root, 'dist');
const entry = join(root, 'webui', 'client.ts');

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [entry],
  outdir,
  entryNames: 'webui',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'warning',
});

for (const file of ['webui.js', 'webui.css']) {
  const path = join(outdir, file);
  if (!existsSync(path)) {
    console.error(`缺少产物 ${path}`);
    process.exit(1);
  }
  console.log(`${file}  ${(statSync(path).size / 1024).toFixed(1)} KiB`);
}
