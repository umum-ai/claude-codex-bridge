import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import manifest from "../.claude-plugin/plugin.json";
import type { ClientRequest } from "../.generated/ClientRequest";
import type { InitializeResponse } from "../.generated/InitializeResponse";
import type { ServerNotification } from "../.generated/ServerNotification";
import type { ServerRequest } from "../.generated/ServerRequest";
import type { ModelListResponse } from "../.generated/v2/ModelListResponse";
import type { ThreadResumeResponse } from "../.generated/v2/ThreadResumeResponse";
import type { ThreadStartResponse } from "../.generated/v2/ThreadStartResponse";
import type { TurnStartResponse } from "../.generated/v2/TurnStartResponse";
import type { TurnSteerResponse } from "../.generated/v2/TurnSteerResponse";

type Results = {
  initialize: InitializeResponse;
  "model/list": ModelListResponse;
  "thread/start": ThreadStartResponse;
  "thread/resume": ThreadResumeResponse;
  "turn/start": TurnStartResponse;
  "turn/steer": TurnSteerResponse;
  "turn/interrupt": Record<string, never>;
};
type Pending = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class AppServer {
  onNotification?: (event: ServerNotification) => void;
  onRequest?: (request: ServerRequest) => void;
  onFailure?: (error: Error) => void;
  private child?: ChildProcessWithoutNullStreams;
  private ready?: Promise<void>;
  private failure?: Error;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private stopping = false;

  constructor(
    private command = ["codex", "app-server", "--listen", "stdio://"],
    private timeoutMs = 30_000,
  ) {}

  connect(): Promise<void> {
    this.ready ??= this.initialize();
    return this.ready;
  }

  private async initialize() {
    const [command, ...args] = this.command;
    this.child = spawn(command, args, { stdio: "pipe" });
    this.child.stderr.pipe(process.stderr, { end: false });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("exit", (code, signal) =>
      this.fail(new Error(`Codex app-server exited: ${code ?? signal}`)),
    );
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => this.receive(line));
    await this.call("initialize", {
      clientInfo: {
        name: "claude_codex_bridge",
        title: "Claude Codex Bridge",
        version: manifest.version,
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.write({ method: "initialized" });
  }

  call<M extends keyof Results>(
    method: M,
    params: Extract<ClientRequest, { method: M }>["params"],
  ): Promise<Results[M]> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // A timed-out launch may have succeeded; close the connection instead of retrying it.
        this.fail(new Error(`Codex control request timed out: ${method}`));
        this.child?.kill();
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.write({ id, method, params });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  respond(id: string | number, result: unknown) {
    this.write({ id, result });
  }

  reject(id: string | number, message: string) {
    this.write({ id, error: { code: -32601, message } });
  }

  private write(message: unknown) {
    if (this.failure) throw this.failure;
    if (!this.child) throw new Error("Codex app-server is not connected");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string) {
    try {
      const message = JSON.parse(line);
      if (!message || typeof message !== "object")
        throw new Error("Expected a JSON object");
      if (typeof message.method === "string") {
        if (message.id !== undefined)
          this.onRequest?.(message as ServerRequest);
        else this.onNotification?.(message as ServerNotification);
      } else {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      }
    } catch (error) {
      this.fail(new Error(`Invalid Codex protocol event: ${String(error)}`));
      this.child?.kill();
    }
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.onFailure?.(error);
  }

  async close() {
    this.stopping = true;
    this.fail(new Error("Bridge closed"));
    const child = this.child;
    if (
      !child ||
      child.exitCode !== null ||
      child.signalCode !== null ||
      !child.pid
    )
      return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }
}
