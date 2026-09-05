import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { model: { type: "string" } },
});
const root = resolve(import.meta.dir, "..");
const cwd = resolve(root, ".runtime/smoke-work");
await mkdir(cwd, { recursive: true });
let client: Client;
const events: { content: string; meta: Record<string, string> }[] = [];
function makeClient() {
  const client = new Client({ name: "bridge-smoke", version: "1" });
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
      console.log(
        JSON.stringify({
          kind: params.meta.kind,
          threadId: params.meta.thread_id,
          text: params.content.slice(0, 250),
        }),
      );
    },
  );
  return client;
}
const transport = () =>
  new StdioClientTransport({
    command: process.execPath,
    args: [resolve(root, "src/index.ts")],
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
    stderr: "inherit",
  });
const call = async (name: string, args?: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(JSON.stringify(result.content));
  return result.structuredContent as Record<string, unknown>;
};
async function waitFor(
  threadId: unknown,
  kind: string,
  after = 0,
  timeout = 90_000,
) {
  const deadline = Date.now() + timeout;
  while (
    !events
      .slice(after)
      .some(
        (event) =>
          event.meta.thread_id === threadId && event.meta.kind === kind,
      )
  ) {
    if (
      events
        .slice(after)
        .some(
          (event) =>
            event.meta.thread_id === threadId &&
            ["failed", "unavailable"].includes(event.meta.kind),
        )
    )
      throw new Error("Codex run failed");
    if (Date.now() > deadline)
      throw new Error(`No ${kind} event within ${timeout}ms`);
    await Bun.sleep(100);
  }
}
client = makeClient();
try {
  await client.connect(transport());
  console.log(JSON.stringify({ capabilities: client.getServerCapabilities() }));
  const models = await call("codex_models");
  console.log(JSON.stringify({ models }));
  const startedAt = Date.now();
  const session = await call("codex_start", {
    cwd,
    model: values.model,
    prompt:
      "This is an integration test. Do not read or edit any files. Run the shell command sleep 12 once. Before running it, send a short progress message. Wait for the command to finish, then report the latest instruction you received. Do not spawn agents.",
  });
  const acceptanceMs = Date.now() - startedAt;
  console.log(JSON.stringify({ accepted: session, acceptanceMs }));
  await waitFor(session.threadId, "activity");
  const steering = await call("codex_message", {
    threadId: session.threadId,
    message:
      "After the running command finishes, make your final answer exactly BRIDGE_STEER_OK.",
  });
  if (steering.mode !== "steered")
    throw new Error("Message did not reach the running turn");
  await waitFor(session.threadId, "completed");
  const status = await call("codex_status", { threadId: session.threadId });
  if (!JSON.stringify(status).includes("BRIDGE_STEER_OK"))
    throw new Error("Final answer did not reflect steering");
  const second = await call("codex_start", {
    cwd,
    model: values.model,
    prompt:
      "Integration test: do not read or edit files. Run sleep 60 once, then say done. Do not spawn agents.",
  });
  await waitFor(second.threadId, "activity");
  await call("codex_stop", { threadId: second.threadId });
  await waitFor(second.threadId, "interrupted");
  await client.close();
  client = makeClient();
  await client.connect(transport());
  const resumed = await call("codex_resume", { threadId: session.threadId });
  if (resumed.lastAnswer !== "BRIDGE_STEER_OK")
    throw new Error("Saved answer was not recovered");
  const resumeEventStart = events.length;
  const continuation = await call("codex_message", {
    threadId: session.threadId,
    message: "Without tools, answer exactly BRIDGE_RESUME_OK.",
  });
  if (continuation.mode !== "new_turn")
    throw new Error("Resume did not start a new turn");
  await waitFor(session.threadId, "completed", resumeEventStart);
  const recovered = await call("codex_status", { threadId: session.threadId });
  if (!JSON.stringify(recovered).includes("BRIDGE_RESUME_OK"))
    throw new Error("Resumed turn did not finish");
  const evidence = {
    acceptanceMs,
    threadId: session.threadId,
    interruptedThreadId: second.threadId,
    status,
    recovered,
    events,
  };
  await Bun.write(
    resolve(root, ".runtime/smoke.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log(
    "PASS: live MCP start, channel notifications, steering, interruption, restart and resume",
  );
} finally {
  await client.close();
}
