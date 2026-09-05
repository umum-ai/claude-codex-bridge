import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

test("installed plugin bundle runs outside the source tree with no node_modules and emits live events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-codex-plugin-"));
  const plugin = join(directory, "plugin cache with spaces");
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
    await cp(
      resolve(
        import.meta.dir,
        "../.runtime/marketplace/plugins/claude-codex-bridge",
      ),
      plugin,
      { recursive: true },
    );
    expect(
      await Bun.file(join(plugin, "node_modules/package.json")).exists(),
    ).toBe(false);
    const bin = join(directory, "bin");
    await mkdir(bin);
    await writeFile(
      join(bin, "codex"),
      `#!/usr/bin/env bun\nimport ${JSON.stringify(pathToFileURL(resolve(import.meta.dir, "fixtures/app-server.ts")).href)};\n`,
      { mode: 0o755 },
    );
    const manifest = await Bun.file(
      join(plugin, ".claude-plugin/plugin.json"),
    ).json();
    const entry = manifest.mcpServers[manifest.channels[0].server];
    await client.connect(
      new StdioClientTransport({
        command: entry.command,
        args: entry.args.map((arg: string) =>
          arg.replaceAll(/\$\{CLAUDE_PLUGIN_ROOT\}/g, () => plugin),
        ),
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
});

test("release ZIP contains only the installable plugin and has a matching checksum", async () => {
  const root = resolve(import.meta.dir, "..");
  const archive = resolve(root, ".runtime/release/claude-codex-bridge.zip");
  const listing = Bun.spawnSync([
    "python",
    "-c",
    "import json, sys, zipfile; z=zipfile.ZipFile(sys.argv[1]); print(json.dumps({'files': sorted(z.namelist()), 'manifest': json.loads(z.read('.claude-plugin/plugin.json'))}))",
    archive,
  ]);
  expect(listing.exitCode).toBe(0);
  const contents = JSON.parse(listing.stdout.toString());
  expect(contents.files).toEqual([
    ".claude-plugin/plugin.json",
    "README.md",
    "dist/server.js",
  ]);
  const manifest = await Bun.file(
    resolve(root, ".claude-plugin/plugin.json"),
  ).json();
  expect(contents.manifest).toEqual(manifest);
  const digest = new Bun.CryptoHasher("sha256")
    .update(await Bun.file(archive).arrayBuffer())
    .digest("hex");
  expect(
    await Bun.file(resolve(root, ".runtime/release/SHA256SUMS")).text(),
  ).toBe(`${digest}  claude-codex-bridge.zip\n`);
  const marketplace = await Bun.file(
    resolve(root, ".claude-plugin/marketplace.json"),
  ).json();
  expect(marketplace.plugins[0].version).toBe(manifest.version);
  expect(marketplace.plugins[0].source.url).toBe(
    `https://github.com/umum-ai/claude-codex-bridge/releases/download/${manifest.version}/claude-codex-bridge.zip`,
  );
});
