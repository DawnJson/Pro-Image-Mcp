import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { isInside } from "./paths.js";

export interface Config {
  apiKey: string;
  baseUrl: string;
  saveDir: string;
  /** Sandbox root: every `save_dir` argument must resolve inside it. */
  saveRoot: string;
  /** When set, every reference image path must resolve inside it. */
  inputRoot?: string;
  /**
   * Hosts the server is willing to download returned images from. An entry
   * matches the host itself and anything under it, so `prorisehub.com` covers
   * `cdn.prorisehub.com`.
   */
  trustedDownloadHosts: string[];
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

/**
 * The API key travels as a bearer token on every request, so a plaintext base
 * URL leaks it to anyone on the path. http is tolerated only for a loopback
 * relay, whose traffic never leaves the machine.
 */
function assertTransportSecurity(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`PROIMAGE_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback) return;
  throw new Error(
    `PROIMAGE_BASE_URL must use https - http is accepted only for localhost. Got: ${baseUrl}. ` +
      `The API key is sent as a bearer token on every request and would travel in plaintext.`,
  );
}

/**
 * Which hosts may serve the generated image bytes. The relay hands back a URL
 * and the server fetches it, so an unconstrained list turns the relay into a
 * request generator pointed at anything reachable from this machine. The
 * default trusts the relay's own host and its parent domain, because CDN
 * hostnames sit next to the API hostname.
 */
function defaultDownloadHosts(baseUrl: string): string[] {
  const host = new URL(baseUrl).hostname.toLowerCase();
  const hosts = [host];
  const labels = host.split(".");
  const isIpv4 = /^\d+(\.\d+){3}$/.test(host);
  if (!isIpv4 && labels.length > 2) hosts.push(labels.slice(-2).join("."));
  return hosts;
}

function envHosts(name: string, fallback: string[]): string[] {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const hosts = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return hosts.length ? hosts : fallback;
}

function envDir(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? resolve(raw) : undefined;
}

export function loadConfig(): Config {
  const apiKey = process.env.PROIMAGE_API_KEY?.trim() ?? "";
  if (!apiKey) {
    throw new Error(
      "PROIMAGE_API_KEY is not set. Add it to your MCP server config env block.",
    );
  }
  // Trailing slashes break path joining against the /v1 prefix.
  const baseUrl = (process.env.PROIMAGE_BASE_URL?.trim() || "https://newapi.prorisehub.com").replace(/\/+$/, "");
  assertTransportSecurity(baseUrl);

  const saveDir = envDir("PROIMAGE_SAVE_DIR") ?? join(homedir(), "Pictures", "pro-image-mcp");
  // Confining writes to the save dir itself is the useful default: a save_dir
  // argument comes from the model, not the user.
  const saveRoot = envDir("PROIMAGE_SAVE_DIR_ROOT") ?? saveDir;
  if (!isInside(saveRoot, saveDir)) {
    throw new Error(
      `PROIMAGE_SAVE_DIR (${saveDir}) is outside PROIMAGE_SAVE_DIR_ROOT (${saveRoot}), ` +
        `so nothing could ever be saved. Widen the root or move the save dir.`,
    );
  }

  const inputRoot = envDir("PROIMAGE_INPUT_ROOT");
  if (inputRoot && !isAbsolute(inputRoot)) {
    throw new Error(`PROIMAGE_INPUT_ROOT must be an absolute path. Got: ${inputRoot}`);
  }

  return {
    apiKey,
    baseUrl,
    saveDir,
    saveRoot,
    inputRoot,
    trustedDownloadHosts: envHosts("PROIMAGE_TRUSTED_DOWNLOAD_HOSTS", defaultDownloadHosts(baseUrl)),
    defaultModel: process.env.PROIMAGE_DEFAULT_MODEL?.trim() || "gpt-image-2",
    timeoutMs: envInt("PROIMAGE_TIMEOUT_MS", 300_000),
    maxConcurrency: envInt("PROIMAGE_CONCURRENCY", 3),
  };
}
