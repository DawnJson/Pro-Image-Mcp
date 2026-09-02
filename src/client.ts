import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { Config } from "./config.js";

/** Diagnostics the relay attaches to every image response. */
export interface ImageMeta {
  credits_charged?: number;
  quality_used?: string;
  downgraded?: boolean;
  size_downgraded?: boolean;
  generation_size?: string;
  target_size?: string;
  references_uploaded?: number;
  mask_received_but_ignored?: boolean;
  attempts?: number;
  run_id?: string;
  history_id?: string;
}

export interface ImageResponse {
  created?: number;
  model?: string;
  data: Array<{ url?: string; b64_json?: string }>;
  _meta?: ImageMeta;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * The relay wraps upstream failures twice: the outer body is
 * {"error":{"message":"400: {\"error\":\"...\"}"}}. Peel both so the caller
 * sees the actual reason instead of "bad_response_status_code".
 */
function unwrapError(body: string, status: number): ApiError {
  let code: string | undefined;
  let message = body.trim();

  try {
    const parsed = JSON.parse(body);
    const err = parsed?.error;
    if (err) {
      code = typeof err.code === "string" ? err.code : undefined;
      message = typeof err.message === "string" ? err.message : JSON.stringify(err);
    }
  } catch {
    // Non-JSON body: fall through with the raw text.
  }

  // Inner layer, e.g. `400: {"error":"Bad Request: Invalid option: ..."}`
  const nested = /^\s*\d{3}:\s*(\{.*\})\s*$/s.exec(message);
  if (nested) {
    try {
      const inner = JSON.parse(nested[1]);
      if (typeof inner?.error === "string") message = inner.error;
      else if (typeof inner?.error?.message === "string") message = inner.error.message;
    } catch {
      // Keep the outer message.
    }
  }

  return new ApiError(message.slice(0, 1000), status, code);
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export class RelayClient {
  constructor(private readonly cfg: Config) {}

  private async request(path: string, init: RequestInit, timeoutMs = this.cfg.timeoutMs): Promise<Response> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.cfg.baseUrl}${path}`, {
        ...init,
        signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, ...(init.headers ?? {}) },
      });
      if (!res.ok) throw unwrapError(await res.text(), res.status);
      return res;
    } catch (e) {
      if (e instanceof ApiError) throw e;
      if (e instanceof Error && e.name === "AbortError") {
        throw new ApiError(`Request to ${path} timed out after ${timeoutMs}ms.`, 408);
      }
      throw new ApiError(`Request to ${path} failed: ${(e as Error).message}`, 0);
    } finally {
      clearTimeout(timer);
    }
  }

  async generate(body: Record<string, unknown>): Promise<ImageResponse> {
    const res = await this.request("/v1/images/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as ImageResponse;
  }

  /** `/v1/images/edits` is multipart; >1 reference goes in repeated `image[]` fields. */
  async edit(
    imagePaths: string[],
    fields: Record<string, string>,
  ): Promise<ImageResponse> {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);

    const fieldName = imagePaths.length > 1 ? "image[]" : "image";
    for (const p of imagePaths) {
      const bytes = await readFile(p);
      const mime = MIME_BY_EXT[extname(p).toLowerCase()] ?? "application/octet-stream";
      form.append(fieldName, new Blob([new Uint8Array(bytes)], { type: mime }), basename(p));
    }

    const res = await this.request("/v1/images/edits", { method: "POST", body: form });
    return (await res.json()) as ImageResponse;
  }

  async listModels(): Promise<Array<{ id: string; supported_endpoint_types?: string[] }>> {
    const res = await this.request("/v1/models", { method: "GET" }, 30_000);
    const json = (await res.json()) as { data?: Array<{ id: string; supported_endpoint_types?: string[] }> };
    return json.data ?? [];
  }

  async pricing(): Promise<PricingEntry[]> {
    const res = await this.request("/api/pricing", { method: "GET" }, 60_000);
    const json = (await res.json()) as { data?: PricingEntry[] };
    return json.data ?? [];
  }

  async billing(): Promise<BillingInfo | null> {
    try {
      const res = await this.request("/v1/dashboard/billing/subscription", { method: "GET" }, 30_000);
      return (await res.json()) as BillingInfo;
    } catch {
      return null; // Optional diagnostic; never fail server_info over it.
    }
  }

  /** The relay returns URLs with a leading space, so every URL must be trimmed. */
  async download(url: string): Promise<Buffer> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs);
    try {
      const res = await fetch(url.trim(), { signal: ctl.signal });
      if (!res.ok) throw new ApiError(`Downloading image failed: HTTP ${res.status}`, res.status);
      return Buffer.from(await res.arrayBuffer());
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface PricingEntry {
  model_name: string;
  description?: string;
  quota_type?: number;
  model_price?: number;
  model_ratio?: number;
  supported_endpoint_types?: string[];
  tags?: string;
}

export interface BillingInfo {
  hard_limit_usd?: number;
  soft_limit_usd?: number;
  system_hard_limit_usd?: number;
}
