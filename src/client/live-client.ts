import type { ServerMessage } from "../shared/live";

const liveSocketUrl = () =>
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/live`;

export function connectLive(
  hello: Record<string, unknown>,
  onMessage: (msg: ServerMessage) => void,
  onConnection: (connected: boolean) => void,
) {
  let ws: WebSocket | null = null;
  let retry = 0;
  let ping = 0;

  const open = () => {
    ws = new WebSocket(liveSocketUrl());
    ws.addEventListener("open", () => {
      retry = 0;
      ws?.send(JSON.stringify({ type: "hello", ...hello }));
      onConnection(true);
      window.clearInterval(ping);
      ping = window.setInterval(() => ws?.readyState === WebSocket.OPEN && ws.send("ping"), 25_000);
    });
    ws.addEventListener("message", (e) => {
      if (typeof e.data !== "string" || e.data === "pong") return;
      try {
        onMessage(JSON.parse(e.data) as ServerMessage);
      } catch {}
    });
    ws.addEventListener("close", () => {
      window.clearInterval(ping);
      onConnection(false);
      const delay = Math.min(10_000, 500 * 2 ** retry++);
      window.setTimeout(open, delay);
    });
  };

  open();
  return {
    send: (msg: Record<string, unknown>) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    },
  };
}
