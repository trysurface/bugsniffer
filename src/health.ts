import http from "http";
import { config } from "./config.js";

export function startHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          uptime: process.uptime(),
          timestamp: new Date().toISOString(),
        })
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("bugsniffer is running.");
  });

  server.listen(config.port, () => {
    console.log(`[health] Listening on port ${config.port}`);
  });

  return server;
}
