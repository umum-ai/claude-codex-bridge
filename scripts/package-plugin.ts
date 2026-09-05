import { chmod, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const destination = resolve(root, ".runtime/release");
await rm(resolve(root, "dist"), { recursive: true, force: true });
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const build = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: resolve(root, "dist"),
  naming: "server.js",
  target: "bun",
});
if (!build.success) throw new AggregateError(build.logs, "npm bundle failed");
await chmod(resolve(root, "dist/server.js"), 0o755);
const pack = Bun.spawnSync(
  [
    "npm",
    "pack",
    "--ignore-scripts",
    "--json",
    "--pack-destination",
    destination,
  ],
  { cwd: root },
);
if (pack.exitCode !== 0) throw new Error(pack.stderr.toString());
await Bun.write(resolve(destination, "pack.json"), pack.stdout);
console.log(pack.stdout.toString());
