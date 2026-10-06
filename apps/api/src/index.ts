import { createServer } from "node:http";
import { contractVersion, type ScaffoldHealth } from "@morrow/contracts";
const port = Number(process.env.MORROW_API_PORT ?? "4100");
const server = createServer((request, response) => {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "application/json");
  if (request.method === "GET" && request.url === "/health") {
    const health: ScaffoldHealth = { service: "api", contracts: contractVersion, mode: "scaffold" };
    response.end(JSON.stringify(health));
    return;
  }
  if (request.url?.startsWith("/workspace")) {
    response.statusCode = 401;
    response.end(JSON.stringify({ code: "authentication_required" }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ code: "not_found" }));
});
server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close());
