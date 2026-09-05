import { spawnSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const destination = resolve(root, ".runtime/release");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await build({
  entryPoints: [resolve(root, "src/index.ts")],
  outfile: resolve(root, "dist/server.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // Bundled CommonJS dependencies still need Node's require for built-in modules.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
await chmod(resolve(root, "dist/server.js"), 0o755);
const pack = spawnSync(
  "npm",
  ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
  { cwd: root, encoding: "utf8" },
);
if (pack.status !== 0) throw pack.error ?? new Error(pack.stderr);
await writeFile(resolve(destination, "pack.json"), pack.stdout);
console.log(pack.stdout);
