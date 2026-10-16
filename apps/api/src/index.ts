import { createServer } from "node:http";
import { createWorkspaceApiHttpListener } from "./workspace-router.js";
const port = Number(process.env.MORROW_API_PORT ?? "4100");
const server = createServer({ maxHeaderSize: 8192 }, createWorkspaceApiHttpListener());
server.maxHeadersCount = 64;
server.headersTimeout = 5000;
server.requestTimeout = 5000;
server.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => server.close());
