import { resolve } from "node:path";

const version = process.argv[2];
if (!version || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
  throw new Error("Usage: mise run release:prepare -- X.Y.Z");
}
const root = resolve(import.meta.dir, "..");
const manifestPath = resolve(root, ".claude-plugin/plugin.json");
const marketplacePath = resolve(root, ".claude-plugin/marketplace.json");
const manifest = await Bun.file(manifestPath).json();
const marketplace = await Bun.file(marketplacePath).json();
manifest.version = version;
const entry = marketplace.plugins.find(
  (plugin: { name: string }) => plugin.name === manifest.name,
);
if (!entry) throw new Error(`Marketplace entry missing for ${manifest.name}`);
entry.version = version;
entry.source = {
  source: "archive",
  url: `https://github.com/umum-ai/claude-codex-bridge/releases/download/${version}/${manifest.name}.zip`,
};
await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await Bun.write(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
const format = Bun.spawnSync(
  [
    process.execPath,
    "x",
    "--no-install",
    "biome",
    "format",
    "--write",
    manifestPath,
    marketplacePath,
  ],
  { cwd: root },
);
if (format.exitCode !== 0) throw new Error(format.stderr.toString());
const build = Bun.spawnSync([process.execPath, "scripts/package-plugin.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (build.exitCode !== 0) throw new Error("Release build failed");
entry.source.sha256 = new Bun.CryptoHasher("sha256")
  .update(
    await Bun.file(
      resolve(root, ".runtime/release", `${manifest.name}.zip`),
    ).arrayBuffer(),
  )
  .digest("hex");
await Bun.write(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
await Bun.write(
  resolve(root, ".runtime/release/marketplace.json"),
  `${JSON.stringify(marketplace, null, 2)}\n`,
);
console.log(`Prepared ${manifest.name} ${version}`);
