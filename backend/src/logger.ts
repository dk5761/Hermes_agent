import pino, { type Logger } from "pino";
import type { AppConfig } from "./config.js";

export function buildLogger(config: Pick<AppConfig, "NODE_ENV">): Logger {
  return pino({
    level: process.env.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug"),
    base: { service: "hermes-gateway" },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export type AppLogger = Logger;
