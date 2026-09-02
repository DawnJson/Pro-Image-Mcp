import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
  apiKey: string;
  baseUrl: string;
  saveDir: string;
  defaultModel: string;
  timeoutMs: number;
  maxConcurrency: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(): Config {
  const apiKey = process.env.PROIMAGE_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      "PROIMAGE_API_KEY is not set. Add it to your MCP server config env block.",
    );
  }
  // Trailing slashes break path joining against the /v1 prefix.
  const baseUrl = (process.env.PROIMAGE_BASE_URL?.trim() || "https://us.prorisehub.com").replace(/\/+$/, "");
  return {
    apiKey,
    baseUrl,
    saveDir: process.env.PROIMAGE_SAVE_DIR?.trim() || join(homedir(), "Pictures", "pro-image-mcp"),
    defaultModel: process.env.PROIMAGE_DEFAULT_MODEL?.trim() || "gpt-image-2",
    timeoutMs: envInt("PROIMAGE_TIMEOUT_MS", 300_000),
    maxConcurrency: envInt("PROIMAGE_CONCURRENCY", 3),
  };
}
