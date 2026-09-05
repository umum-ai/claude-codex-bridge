import type { Readable, Writable } from "node:stream";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AppServer } from "./app-server";
import { createServer } from "./server";

export async function main(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  rpc = new AppServer(),
) {
  const { server, bridge } = createServer(rpc);
  let closing: Promise<void> | undefined;
  const shutdown = () => {
    closing ??= (async () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      input.off("end", shutdown);
      output.off("error", shutdown);
      await bridge.close();
      await server.close();
    })();
    return closing;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // The MCP SDK transport does not close itself when its input reaches EOF.
  input.once("end", shutdown);
  output.once("error", shutdown);
  await server.connect(new StdioServerTransport(input, output));
  return { bridge, shutdown };
}

if (import.meta.main) await main();
