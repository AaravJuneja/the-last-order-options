import { DurableObject } from "cloudflare:workers";
import type { Question } from "../shared/question";
import {
  clampSensitivity,
  SENSITIVITY,
  type LiveAnswer,
  type LiveSettings,
  type LiveState,
  type LiveTally,
  type ServerMessage,
} from "../shared/live";

const START_DELAY_MS = 1500;

type Role = "display" | "admin";
type Attachment = { role: Role | null; id: string | null };

const EMPTY_STATE: LiveState = {
  revision: 0,
  mode: "waiting",
  question: null,
  startsAt: null,
  lastQuestionId: null,
};

type RoomEnv = { readonly BUILD_ID?: string };

export class LiveRoom extends DurableObject<RoomEnv> {
  private live: LiveState = EMPTY_STATE;
  private answers: Record<string, LiveAnswer> = {};
  private settings: LiveSettings = { sensitivity: SENSITIVITY.default };

  constructor(ctx: DurableObjectState, env: RoomEnv) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.live = (await ctx.storage.get<LiveState>("live")) ?? EMPTY_STATE;
      this.answers = (await ctx.storage.get<Record<string, LiveAnswer>>("answers")) ?? {};
      this.settings = (await ctx.storage.get<LiveSettings>("settings")) ?? this.settings;
    });
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade.", { status: 426 });
    }
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null, id: null } satisfies Attachment);
    this.send(server, this.stateMessage());
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > 2000) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === "hello") {
      const role: Role = msg.role === "admin" ? "admin" : "display";
      const id = typeof msg.id === "string" ? msg.id.slice(0, 64) : null;
      ws.serializeAttachment({ role, id } satisfies Attachment);
      this.send(ws, this.stateMessage());
      if (role === "admin") this.send(ws, this.tallyMessage());
      this.broadcastPresence();
      return;
    }

    if (msg.type === "choice") {
      const { role, id } = (ws.deserializeAttachment() ?? {}) as Attachment;
      if (role !== "display" || !id) return;
      if (this.live.mode !== "question" || msg.revision !== this.live.revision) return;
      if (this.answers[id]) return;
      const option = msg.option === 1 ? 1 : 0;
      this.answers[id] = { option, timedOut: msg.timedOut === true };
      await this.ctx.storage.put("answers", this.answers);
      this.broadcast("admin", this.tallyMessage());
    }
  }

  async webSocketClose(ws: WebSocket) {
    ws.close();
    this.broadcastPresence();
  }

  async webSocketError() {
    this.broadcastPresence();
  }

  async show(question: Question | null): Promise<LiveState> {
    this.live = {
      revision: this.live.revision + 1,
      mode: question ? "question" : "waiting",
      question,
      startsAt: question ? Date.now() + START_DELAY_MS : null,
      lastQuestionId: question ? question.id : this.live.lastQuestionId,
    };
    this.answers = {};
    await this.ctx.storage.put({ live: this.live, answers: this.answers });
    this.broadcast(null, this.stateMessage());
    this.broadcast("admin", this.tallyMessage());
    return this.live;
  }

  async reset(): Promise<LiveState> {
    await this.show(null);
    this.live = { ...this.live, lastQuestionId: null };
    await this.ctx.storage.put("live", this.live);
    this.broadcast(null, this.stateMessage());
    return this.live;
  }

  async setSensitivity(value: number): Promise<LiveSettings> {
    this.settings = { sensitivity: clampSensitivity(value) };
    await this.ctx.storage.put("settings", this.settings);
    this.broadcast(null, { type: "settings", settings: this.settings });
    return this.settings;
  }

  async status() {
    return {
      live: this.live,
      displays: this.displayCount(),
      tally: this.tally(),
      settings: this.settings,
    };
  }

  private tally(): LiveTally {
    const counts = { option0: 0, option1: 0, timedOut: 0 };
    for (const a of Object.values(this.answers)) {
      if (a.timedOut) counts.timedOut++;
      else if (a.option === 1) counts.option1++;
      else counts.option0++;
    }
    return { revision: this.live.revision, ...counts };
  }

  private displayCount() {
    return this.ctx.getWebSockets().filter((ws) => {
      const a = ws.deserializeAttachment() as Attachment | null;
      return a?.role === "display";
    }).length;
  }

  private stateMessage(): ServerMessage {
    return {
      type: "state",
      serverNow: Date.now(),
      live: this.live,
      settings: this.settings,
      build: this.env.BUILD_ID ?? "dev",
    };
  }

  private tallyMessage(): ServerMessage {
    return { type: "tally", tally: this.tally(), displays: this.displayCount() };
  }

  private broadcastPresence() {
    this.broadcast("admin", { type: "presence", displays: this.displayCount() });
  }

  private broadcast(role: Role | null, msg: ServerMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (role === null || a?.role === role) {
        try {
          ws.send(data);
        } catch {}
      }
    }
  }

  private send(ws: WebSocket, msg: ServerMessage) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {}
  }
}
