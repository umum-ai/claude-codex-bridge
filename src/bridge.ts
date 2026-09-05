import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ServerNotification } from "../.generated/ServerNotification";
import type { ServerRequest } from "../.generated/ServerRequest";
import type { ToolRequestUserInputParams } from "../.generated/v2/ToolRequestUserInputParams";
import type { AppServer } from "./app-server";

export type BridgeEvent = {
  sequence: number;
  threadId: string;
  kind: string;
  text: string;
  truncated: boolean;
  timestamp: string;
};
type Question = { requestId: string; params: ToolRequestUserInputParams };
type Session = {
  threadId: string;
  model: string;
  cwd: string;
  status:
    | "idle"
    | "running"
    | "waiting_input"
    | "completed"
    | "interrupted"
    | "failed"
    | "unavailable";
  turnId: string | null;
  lastTurnId: string | null;
  lastAnswer: string;
  answerTruncated: boolean;
  questions: Question[];
};

export class Bridge {
  private sessions = new Map<string, Session>();
  private requests = new Map<
    string,
    ServerRequest & { method: "item/tool/requestUserInput" }
  >();
  private busy = new Set<string>();
  private journal: BridgeEvent[] = [];
  private sequence = 0;
  private buffers = new Map<
    string,
    { text: string; truncated: boolean; timer: ReturnType<typeof setTimeout> }
  >();
  private delivery = Promise.resolve();
  private closed = false;
  channelError: string | null = null;
  failure: string | null = null;

  constructor(
    private rpc: AppServer,
    private publish: (event: BridgeEvent) => Promise<void>,
    private progressMs = 1_000,
    private journalLimit = 200,
  ) {
    rpc.onNotification = (event) => this.notification(event);
    rpc.onRequest = (request) => this.request(request);
    rpc.onFailure = (error) => {
      this.failure = error.message;
      this.requests.clear();
      for (const session of this.sessions.values()) {
        this.flush(session.threadId);
        session.status = "unavailable";
        session.turnId = null;
        session.questions = [];
        this.emit(session.threadId, "unavailable", error.message);
      }
    };
  }

  async models(cursor?: string) {
    await this.rpc.connect();
    return this.rpc.call("model/list", { cursor, limit: 100 });
  }

  async start(input: { prompt: string; cwd: string; model?: string }) {
    if (!isAbsolute(input.cwd) || !(await stat(input.cwd)).isDirectory()) {
      throw new Error("cwd must be an existing absolute directory");
    }
    await this.rpc.connect();
    const result = await this.rpc.call("thread/start", {
      cwd: input.cwd,
      model: input.model,
      allowProviderModelFallback: false,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const session = this.attach(result.thread.id, result.model, result.cwd);
    return this.lock(session, async () => {
      await this.begin(session, input.prompt);
      return this.snapshot(session);
    });
  }

  async resume(threadId: string) {
    if (this.sessions.has(threadId))
      return this.snapshot(this.session(threadId));
    await this.rpc.connect();
    const result = await this.rpc.call("thread/resume", {
      threadId,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      initialTurnsPage: { limit: 1, sortDirection: "desc", itemsView: "full" },
    });
    const session = this.attach(result.thread.id, result.model, result.cwd);
    const turn = result.initialTurnsPage?.data[0] ?? result.thread.turns.at(-1);
    if (turn) {
      session.lastTurnId = turn.id;
      session.turnId = turn.status === "inProgress" ? turn.id : null;
      session.status = turn.status === "inProgress" ? "running" : turn.status;
    }
    for (const item of turn?.items ?? []) {
      if (item.type === "agentMessage") this.answerText(session, item.text);
    }
    return this.snapshot(session);
  }

  async message(threadId: string, message: string) {
    const session = this.session(threadId);
    return this.lock(session, async () => {
      if (session.turnId) {
        await this.rpc.call("turn/steer", {
          threadId,
          expectedTurnId: session.turnId,
          input: [{ type: "text", text: message, text_elements: [] }],
        });
        return { mode: "steered", ...this.snapshot(session) };
      }
      await this.begin(session, message);
      return { mode: "new_turn", ...this.snapshot(session) };
    });
  }

  async stop(threadId: string) {
    const session = this.session(threadId);
    return this.lock(session, async () => {
      if (!session.turnId)
        return { requested: false, ...this.snapshot(session) };
      await this.rpc.call("turn/interrupt", {
        threadId,
        turnId: session.turnId,
      });
      return { requested: true, ...this.snapshot(session) };
    });
  }

  answer(
    threadId: string,
    requestId: string,
    answers: Record<string, string[]>,
  ) {
    const request = this.requests.get(requestId);
    if (!request || request.params.threadId !== threadId)
      throw new Error("Unknown or expired question");
    const ids = request.params.questions.map((question) => question.id);
    if (
      ids.some((id) => !answers[id]?.length) ||
      Object.keys(answers).some((id) => !ids.includes(id))
    ) {
      throw new Error(
        "Answer every question ID, using only IDs from this request",
      );
    }
    this.rpc.respond(request.id, {
      answers: Object.fromEntries(
        ids.map((id) => [id, { answers: answers[id] }]),
      ),
    });
    this.clearRequest(requestId);
    return this.status(threadId);
  }

  status(threadId?: string) {
    return {
      sessions: threadId
        ? [this.snapshot(this.session(threadId))]
        : [...this.sessions.values()].map((session) => this.snapshot(session)),
      failure: this.failure,
      channelError: this.channelError,
      latestSequence: this.sequence,
    };
  }

  events(after = 0) {
    const oldest = this.journal[0]?.sequence ?? this.sequence + 1;
    return {
      events: this.journal.filter((event) => event.sequence > after),
      latestSequence: this.sequence,
      gap: after < oldest - 1,
    };
  }

  private attach(threadId: string, model: string, cwd: string) {
    const session: Session = {
      threadId,
      model,
      cwd,
      status: "idle",
      turnId: null,
      lastTurnId: null,
      lastAnswer: "",
      answerTruncated: false,
      questions: [],
    };
    this.sessions.set(threadId, session);
    return session;
  }

  private session(threadId: string) {
    const session = this.sessions.get(threadId);
    if (!session)
      throw new Error(
        "Unknown thread; use codex_resume to attach a saved Codex thread",
      );
    return session;
  }

  private snapshot(session: Session) {
    return { ...session, questions: [...session.questions] };
  }

  private async lock<T>(session: Session, action: () => Promise<T>) {
    if (this.busy.has(session.threadId))
      throw new Error("A control request for this thread is already in flight");
    if (session.status === "unavailable")
      throw new Error(this.failure ?? "Codex unavailable");
    this.busy.add(session.threadId);
    try {
      return await action();
    } finally {
      this.busy.delete(session.threadId);
    }
  }

  private async begin(session: Session, text: string) {
    session.lastAnswer = "";
    session.answerTruncated = false;
    try {
      // turn/started may arrive before this response; notifications own the live state.
      const result = await this.rpc.call("turn/start", {
        threadId: session.threadId,
        input: [{ type: "text", text, text_elements: [] }],
      });
      if (session.lastTurnId !== result.turn.id) {
        session.lastTurnId = result.turn.id;
        session.turnId =
          result.turn.status === "inProgress" ? result.turn.id : null;
        session.status =
          result.turn.status === "inProgress" ? "running" : result.turn.status;
      }
    } catch (error) {
      if (session.status !== "unavailable") session.status = "failed";
      this.emit(session.threadId, "error", String(error));
      throw error;
    }
  }

  private notification(event: ServerNotification) {
    if (this.closed || !("threadId" in event.params) || !event.params.threadId)
      return;
    const session = this.sessions.get(event.params.threadId);
    if (!session) return;
    switch (event.method) {
      case "turn/started":
        session.lastTurnId = event.params.turn.id;
        session.turnId = event.params.turn.id;
        session.status = "running";
        this.emit(
          session.threadId,
          "started",
          `Turn ${session.turnId} started`,
        );
        break;
      case "item/agentMessage/delta":
      case "item/commandExecution/outputDelta":
        this.buffer(session.threadId, event.params.delta);
        break;
      case "item/started":
      case "item/completed": {
        const item = event.params.item;
        if (item.type === "agentMessage" && event.method === "item/completed") {
          this.flush(session.threadId);
          this.answerText(session, item.text);
          this.emit(session.threadId, "message", item.text);
        } else if (
          [
            "commandExecution",
            "fileChange",
            "mcpToolCall",
            "dynamicToolCall",
            "plan",
          ].includes(item.type)
        ) {
          this.emit(
            session.threadId,
            event.method === "item/started" ? "activity" : "activity_completed",
            JSON.stringify(item),
          );
        }
        break;
      }
      case "turn/completed":
        session.lastTurnId = event.params.turn.id;
        this.flush(session.threadId);
        session.status =
          event.params.turn.status === "inProgress"
            ? "running"
            : event.params.turn.status;
        session.turnId = null;
        for (const question of [...session.questions])
          this.clearRequest(question.requestId);
        this.emit(
          session.threadId,
          session.status,
          event.params.turn.error?.message ??
            `Turn ${event.params.turn.id} ${session.status}`,
        );
        break;
      case "serverRequest/resolved":
        this.clearRequest(String(event.params.requestId));
        break;
      case "error":
        this.emit(session.threadId, "error", event.params.error.message);
        break;
    }
  }

  private request(request: ServerRequest) {
    if (
      request.method !== "item/tool/requestUserInput" ||
      !this.sessions.has(request.params.threadId)
    ) {
      this.rpc.reject(
        request.id,
        `Bridge does not support Codex request: ${request.method}`,
      );
      return;
    }
    const requestId = String(request.id);
    this.requests.set(requestId, request);
    const session = this.session(request.params.threadId);
    session.questions.push({ requestId, params: request.params });
    if (request.params.isBlocking) session.status = "waiting_input";
    this.emit(
      session.threadId,
      "question",
      JSON.stringify({ requestId, ...request.params }),
    );
  }

  private clearRequest(requestId: string) {
    const request = this.requests.get(requestId);
    if (!request) return;
    this.requests.delete(requestId);
    const session = this.session(request.params.threadId);
    session.questions = session.questions.filter(
      (question) => question.requestId !== requestId,
    );
    if (
      session.status === "waiting_input" &&
      !session.questions.some((question) => question.params.isBlocking)
    )
      session.status = "running";
  }

  private answerText(session: Session, text: string) {
    session.lastAnswer = text.slice(0, 64_000);
    session.answerTruncated = text.length > 64_000;
  }

  private buffer(threadId: string, text: string) {
    const buffer = this.buffers.get(threadId);
    if (buffer) {
      buffer.truncated ||= buffer.text.length + text.length > 8_000;
      buffer.text = (buffer.text + text).slice(-8_000);
    } else
      this.buffers.set(threadId, {
        text: text.slice(-8_000),
        truncated: text.length > 8_000,
        timer: setTimeout(() => this.flush(threadId), this.progressMs),
      });
  }

  private flush(threadId: string) {
    const buffer = this.buffers.get(threadId);
    if (!buffer) return;
    clearTimeout(buffer.timer);
    this.buffers.delete(threadId);
    this.emit(threadId, "progress", buffer.text, buffer.truncated);
  }

  private emit(
    threadId: string,
    kind: string,
    text: string,
    truncated = false,
  ) {
    const event = {
      sequence: ++this.sequence,
      threadId,
      kind,
      text: text.slice(0, 8_000),
      truncated: truncated || text.length > 8_000,
      timestamp: new Date().toISOString(),
    };
    this.journal.push(event);
    if (this.journal.length > this.journalLimit) this.journal.shift();
    this.delivery = this.delivery.then(async () => {
      try {
        await this.publish(event);
        this.channelError = null;
      } catch (error) {
        this.channelError = String(error);
      }
    });
  }

  async close() {
    this.closed = true;
    for (const threadId of this.buffers.keys()) this.flush(threadId);
    await this.rpc.close();
    await this.delivery;
  }
}
