/**
 * One person's inbox (docs/multiplayer.md §12): a Durable Object per user id holding the WebSockets of their open apps
 * (hibernated between messages), so a notification made anywhere reaches the bell at once — no polling. It stores
 * nothing: notifications live in D1 (notifications.ts); a socket that was away reads the list when it comes back.
 * Reached only through the Worker, which has authenticated the person.
 */
import { DurableObject } from "cloudflare:workers";

export class Inbox extends DurableObject {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    // The app's keep-alive is answered by the runtime, without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/inbox/ws" && req.method === "GET") {
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/inbox/notify" && req.method === "POST") {
      const text = await req.text();
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(text);
        } catch {
          // closing
        }
      }
      return Response.json({ ok: true });
    }
    return new Response("not found", { status: 404 });
  }

  /** (A "ping" that reached the object anyway) */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    if (message === "ping") ws.send("pong");
  }

  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    try {
      ws.close(code === 1005 ? 1000 : code, reason);
    } catch {
      // already closed
    }
  }
}
