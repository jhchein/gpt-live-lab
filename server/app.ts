import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { errorMessage, parseClientCommand, type PublicConfig } from "../shared/protocol.ts";
import { LiveSession, type SessionDependencies } from "./live/session.ts";

const origins = new Set(["http://127.0.0.1:5173", "http://localhost:5173"]);

export function createApp(config: PublicConfig, dependencies: Omit<SessionDependencies, "config" | "emit">) {
  const sessions = new Set<LiveSession>();
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/api/config") {
      response.writeHead(200, {
        "Content-Type": "application/json", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify(config));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("Not found");
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 128_000 });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/api/events" || !origins.has(request.headers.origin ?? "")) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (sockets.clients.size > 0) {
      socket.end("HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\nOne demo session at a time.");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (client) => {
    const session = new LiveSession({
      ...dependencies, config,
      emit: (message) => {
        if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(message));
      },
    });
    sessions.add(session);
    let used = false;
    client.on("message", (data) => {
      try {
        const command = parseClientCommand(data.toString());
        if (command.type === "start") {
          if (used) throw new Error("Start a new browser connection for a new session.");
          used = true;
          void session.start(command.sdp);
        } else if (command.type === "prepare") {
          if (used) throw new Error("Session preparation is no longer available.");
          void session.prepareForSession().catch(() => undefined);
        } else if (command.type === "stop") {
          void session.stop();
        } else if (command.type === "search") {
          session.setWebSearch(command.enabled);
        }
      } catch (error) {
        session.trace("backend", "error", "browser.command.error", "Browser command rejected", { message: errorMessage(error) });
      }
    });
    client.on("error", (error) => {
      console.error("Browser WebSocket error:", error.message);
      void session.stop();
    });
    client.on("close", () => {
      void session.stop().finally(() => sessions.delete(session));
    });
  });
  return {
    server,
    async close() {
      await Promise.all([...sessions].map((session) => session.stop()));
      for (const client of sockets.clients) client.terminate();
      sockets.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}
