import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import marketplace from "../.claude-plugin/marketplace.json" with {
  type: "json",
};
import manifest from "../plugins/claude-codex-bridge/.claude-plugin/plugin.json" with {
  type: "json",
};

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    cwd: { type: "string", default: process.cwd() },
    help: { type: "boolean" },
    plugin: { type: "boolean" },
  },
  allowPositionals: true,
});
if (values.help) {
  console.log(
    "Usage: mise run claude -- [--plugin] [--cwd /absolute/project] [-- <Claude arguments>]\nDefault: starts only the development MCP server and channel. --plugin: enables the installed plugin's development channel and keeps other MCP servers. Existing Claude settings are not edited.",
  );
} else {
  const config = {
    mcpServers: {
      "codex-bridge": {
        command: process.execPath,
        args: [resolve(import.meta.dirname, "../dist/server.js")],
      },
    },
  };
  const child = spawn(
    "claude",
    values.plugin
      ? [
          "--dangerously-load-development-channels",
          `plugin:${manifest.name}@${marketplace.name}`,
          ...positionals,
        ]
      : [
          "--mcp-config",
          JSON.stringify(config),
          "--strict-mcp-config",
          "--dangerously-load-development-channels",
          "server:codex-bridge",
          ...positionals,
        ],
    { cwd: resolve(values.cwd), stdio: "inherit" },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
