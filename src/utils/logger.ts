import pino from "pino";
import path from "node:path";

// MCP uses stdio — log to file, NOT stdout
const logDir = process.env.CODE_CONTEXT_LOG_DIR || ".code-context";
const baseDir = process.env.GRAPH_PROJECT_ROOT || process.cwd();
const logPath = path.join(baseDir, logDir, "server.log");

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  transport: {
    target: "pino/file",
    options: { destination: logPath, mkdir: true },
  },
});
