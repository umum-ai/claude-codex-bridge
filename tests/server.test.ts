import { afterEach, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { AppServer } from "../src/app-server";
import { main } from "../src/index";
import { createServer } from "../src/server";

const cleanups: (() => Promise<void>)[] = [];

test("stdio EOF closes the Codex child and shutdown is idempotent", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = new AppServer([
    process.execPath,
    resolve(import.meta.dir, "fixtures/app-server.ts"),
  ]);
  const { bridge, shutdown } = await main(input, output, rpc);
  await bridge.models();
  input.end();
  await Bun.sleep(10);
  await shutdown();
  await shutdown();
  await expect(rpc.call("model/list", {})).rejects.toThrow("closed");
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect() {
  const rpc = new AppServer([
    process.execPath,
    resolve(import.meta.dir, "fixtures/app-server.ts"),
  ]);
  const { server, bridge } = createServer(rpc, 5);
  const client = new Client({ name: "test", version: "1" });
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
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await bridge.close();
    await client.close();
    await server.close();
  });
  const call = async (name: string, args?: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    if (result.isError) throw new Error(JSON.stringify(result.content));
    return result.structuredContent as Record<string, unknown>;
  };
  return { client, events, call };
}

test("MCP advertises channel capability, typed tools, and nonblocking push events", async () => {
  const { client, call, events } = await connect();
  expect(client.getServerCapabilities()?.experimental).toEqual({
    "claude/channel": {},
  });
  const tools = await client.listTools();
  expect(tools.tools.map((tool) => tool.name)).toContain("codex_answer");
  expect(tools.tools.every((tool) => tool.inputSchema.type === "object")).toBe(
    true,
  );
  expect((await call("codex_models")).nextCursor).toBe("page2");
  const session = await call("codex_start", {
    cwd: process.cwd(),
    prompt: "work",
  });
  expect(session.status).toBe("running");
  const threadId = session.threadId;
  await Bun.sleep(30);
  expect(events.some((event) => event.meta.kind === "progress")).toBe(true);
  expect(
    (await call("codex_message", { threadId, message: "steer over MCP" })).mode,
  ).toBe("steered");
  await Bun.sleep(10);
  expect(
    events.some((event) => event.content === "steered: steer over MCP"),
  ).toBe(true);
  expect((await call("codex_stop", { threadId })).requested).toBe(false);
  expect((await call("codex_events")).events).toBeArray();
  expect((await call("codex_status", { threadId })).sessions).toBeArray();
  await call("codex_resume", { threadId: "saved" });
});

test("MCP question answer reaches Codex and tool errors use isError", async () => {
  const { call, events, client } = await connect();
  const session = await call("codex_start", {
    cwd: process.cwd(),
    prompt: "question",
  });
  await Bun.sleep(15);
  const questionEvent = events.find((event) => event.meta.kind === "question");
  expect(questionEvent).toBeDefined();
  const question = JSON.parse(questionEvent?.content ?? "{}");
  await call("codex_answer", {
    threadId: session.threadId,
    requestId: question.requestId,
    answers: { choice: ["A"] },
  });
  await Bun.sleep(10);
  expect(events.some((event) => event.meta.kind === "completed")).toBe(true);
  expect((await client.callTool({ name: "unknown" })).isError).toBe(true);
  expect(
    (
      await client.callTool({
        name: "codex_start",
        arguments: { cwd: process.cwd() },
      })
    ).isError,
  ).toBe(true);
});
