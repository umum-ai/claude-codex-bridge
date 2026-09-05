import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import marketplace from "../.claude-plugin/marketplace.json";
import manifest from "../.claude-plugin/plugin.json";

const root = resolve(import.meta.dir, "..");
const destination = resolve(root, ".runtime/marketplace");
const plugin = resolve(destination, "plugins", manifest.name);
const release = resolve(root, ".runtime/release");
await rm(plugin, { recursive: true, force: true });
await mkdir(resolve(plugin, ".claude-plugin"), { recursive: true });
await mkdir(resolve(destination, ".claude-plugin"), { recursive: true });
await mkdir(release, { recursive: true });

const build = await Bun.build({
  entrypoints: [resolve(root, "src/index.ts")],
  outdir: resolve(plugin, "dist"),
  naming: "server.js",
  target: "bun",
});
if (!build.success)
  throw new AggregateError(build.logs, "Plugin bundle failed");
await copyFile(
  resolve(root, ".claude-plugin/plugin.json"),
  resolve(plugin, ".claude-plugin/plugin.json"),
);
await copyFile(resolve(root, "README.md"), resolve(plugin, "README.md"));
await Bun.write(
  resolve(destination, ".claude-plugin/marketplace.json"),
  `${JSON.stringify(
    {
      ...marketplace,
      plugins: marketplace.plugins.map((entry) => ({
        ...entry,
        source: `./plugins/${entry.name}`,
      })),
    },
    null,
    2,
  )}\n`,
);
await Bun.write(
  resolve(destination, "settings.json"),
  `${JSON.stringify(
    {
      channelsEnabled: true,
      extraKnownMarketplaces: {
        [marketplace.name]: {
          source: { source: "directory", path: destination },
        },
      },
      enabledPlugins: { [`${manifest.name}@${marketplace.name}`]: true },
    },
    null,
    2,
  )}\n`,
);

// Fixed ZIP metadata makes the published checksum reproducible across builds.
const archive = resolve(release, `${manifest.name}.zip`);
const zip = Bun.spawnSync([
  "python",
  "-c",
  `import pathlib, sys, zipfile
root = pathlib.Path(sys.argv[1])
with zipfile.ZipFile(sys.argv[2], "w", compression=zipfile.ZIP_STORED) as archive:
    for path in sorted(root.rglob("*")):
        if path.is_file():
            entry = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2020, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.external_attr = 0o100644 << 16
            archive.writestr(entry, path.read_bytes())
`,
  plugin,
  archive,
]);
if (zip.exitCode !== 0) throw new Error(zip.stderr.toString());
const digest = new Bun.CryptoHasher("sha256")
  .update(await Bun.file(archive).arrayBuffer())
  .digest("hex");
await Bun.write(
  resolve(release, "SHA256SUMS"),
  `${digest}  ${manifest.name}.zip\n`,
);
console.log(`Plugin: ${plugin}\nArchive: ${archive}\nSHA256: ${digest}`);
