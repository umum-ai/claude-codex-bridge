import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

test("npm archive installs offline and its executable emits live events outside the source tree", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-codex-plugin-"));
  const plugin = join(directory, "npm install with spaces");
  const client = new Client({ name: "plugin-package-test", version: "1" });
  const events: { content: string; meta: Record<string, string> }[] = [];
  client.setNotificationHandler(
    z.object({
      method: z.literal("notifications/claude/channel"),
      params: z.object({
        content: z.string(),
        meta: z.record(z.string(), z.string()),
      }),
    }),
    async ({ params }) => {
      events.push(params);
    },
  );
  try {
    await mkdir(plugin);
    await Bun.write(join(plugin, "package.json"), '{"private":true}');
    const [packed] = await Bun.file(
      resolve(import.meta.dir, "../.runtime/release/pack.json"),
    ).json();
    const install = Bun.spawnSync([
      "npm",
      "install",
      "--prefix",
      plugin,
      "--ignore-scripts",
      "--offline",
      "--no-audit",
      "--no-fund",
      resolve(import.meta.dir, "../.runtime/release", packed.filename),
    ]);
    expect(install.exitCode).toBe(0);
    const installed = join(plugin, "node_modules", packed.name);
    expect(await Bun.file(join(installed, "src/index.ts")).exists()).toBe(
      false,
    );
    expect(
      await Bun.file(join(installed, "node_modules/package.json")).exists(),
    ).toBe(false);
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "codex"),
      `#!/usr/bin/env bun\nimport ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "fixtures/app-server.ts")).href)};\n`,
      { mode: 0o755 },
    );
    const manifest = await Bun.file(join(installed, "package.json")).json();
    await client.connect(
      new StdioClientTransport({
        command: join(plugin, "node_modules/.bin/claude-codex-bridge"),
        args: [],
        cwd: directory,
        env: { PATH: `${bin}:${process.env.PATH}` },
      }),
    );
    expect(client.getServerVersion()?.version).toBe(manifest.version);
    expect(client.getServerCapabilities()?.experimental).toEqual({
      "claude/channel": {},
    });
    expect((await client.listTools()).tools.length).toBe(8);
    const started = await client.callTool({
      name: "codex_start",
      arguments: { cwd: directory, prompt: "work" },
    });
    expect(started.isError).not.toBe(true);
    const session = z
      .object({ threadId: z.string(), status: z.string() })
      .parse(started.structuredContent);
    const threadId = session.threadId;
    expect(session.status).toBe("running");
    await client.callTool({
      name: "codex_message",
      arguments: { threadId, message: "packaged steering" },
    });
    const deadline = Date.now() + 2_000;
    while (!events.some((event) => event.meta.kind === "completed")) {
      if (Date.now() > deadline)
        throw new Error("Bundled server did not push completion");
      await Bun.sleep(10);
    }
    expect(
      events.some((event) => event.content === "steered: packaged steering"),
    ).toBe(true);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

test("npm package contains only the bundled executable and user documentation", async () => {
  const root = resolve(import.meta.dir, "..");
  const [packed] = await Bun.file(
    resolve(root, ".runtime/release/pack.json"),
  ).json();
  expect(
    packed.files.map((file: { path: string }) => file.path).sort(),
  ).toEqual(["README.md", "dist/server.js", "package.json"]);
  const pkg = await Bun.file(resolve(root, "package.json")).json();
  expect(packed.name).toBe(pkg.name);
  expect(packed.version).toBe(pkg.version);
  expect(pkg.dependencies).toBeUndefined();
  expect(
    (await Bun.file(resolve(root, "dist/server.js")).text()).startsWith(
      "#!/usr/bin/env bun\n",
    ),
  ).toBe(true);
  const manifest = await Bun.file(
    resolve(root, "plugins/claude-codex-bridge/.claude-plugin/plugin.json"),
  ).json();
  expect(manifest.version).toBe(packed.version);
  expect(manifest.mcpServers["codex-bridge"]).toEqual({
    command: "bunx",
    args: ["--bun", `${packed.name}@${packed.version}`],
  });
  const marketplace = await Bun.file(
    resolve(root, ".claude-plugin/marketplace.json"),
  ).json();
  expect(marketplace.plugins[0].source).toBe("./plugins/claude-codex-bridge");
  expect(marketplace.plugins[0].version).toBe(packed.version);
});
