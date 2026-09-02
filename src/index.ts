#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { access } from "node:fs/promises";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { ApiError, RelayClient, type ImageResponse } from "./client.js";
import { deriveCapability, describeSupport } from "./capabilities.js";
import { estimatePrice, formatUsd } from "./pricing.js";
import { loadConfig } from "./config.js";
import { formatResult, saveImages } from "./result.js";
import { QUALITY_VALUES, SIZE_EXAMPLES, explainSizeError, validateQuality, validateSize } from "./sizes.js";

const cfg = loadConfig();
const client = new RelayClient(cfg);

const QualityArg = z
  .enum(QUALITY_VALUES)
  .describe(
    "Render quality, REQUIRED. low | medium | high. Controls how much work the model puts into the image, and on " +
      "models that carry a quality price rule (gpt-image-2, gpt-image-1-5) it also changes the cost, so it is never " +
      "defaulted. Unrelated to the API key's channel group, which selects the upstream source and cannot be set per " +
      "request. The upstream API does not validate this field; it is validated here.",
  );

const SizeArg = z
  .string()
  .describe(
    `Output pixel size, REQUIRED, "WxH" or "auto". Affects cost. Which aspect ratios are accepted is PER-MODEL: ` +
      `z-image takes only 1:1, 3:4, 4:3, 9:16, 16:9, while gpt-image-2 also takes 3:2 and 21:9. Common choices: ` +
      ${JSON.stringify(SIZE_EXAMPLES.join(", "))}. Ratios beyond 3:1 are refused by every model.`,
  );

const ModelArg = z
  .string()
  .optional()
  .describe(`Model id. Defaults to ${cfg.defaultModel}. Call list_models to see ids and per-image prices.`);

const SaveDirArg = z.string().optional().describe(`Directory for output files. Defaults to ${cfg.saveDir}.`);

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
function fail(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}

/** Turn any thrown value into a message worth showing the caller. */
function describeError(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.code ? ` code=${e.code}` : "";
    return `API request failed (HTTP ${e.status}${code}): ${e.message}`;
  }
  return `Failed: ${(e as Error).message}`;
}

/**
 * Catches bad quality/size before the caller waits 30s for an upstream refusal.
 * Returns a hard error only for combinations that certainly fail; anything
 * merely suspicious comes back as a warning so a valid request is never blocked.
 */
function preflight(quality: string, size: string, model: string): { error?: string; warnings: string[] } {
  const q = validateQuality(quality);
  if (q) return { error: q, warnings: [] };
  const s = validateSize(size, model);
  return { error: s.ok ? undefined : s.error, warnings: s.warnings };
}

/** Prefixes preflight warnings onto a successful result. */
function withWarnings(body: string, warnings: string[]): string {
  if (!warnings.length) return body;
  return `${body}\n\n${warnings.map((w) => `NOTE: ${w}`).join("\n")}`;
}

async function assertReadable(paths: string[]): Promise<string | null> {
  for (const p of paths) {
    try {
      await access(p);
    } catch {
      return `Image not found or unreadable: ${p}`;
    }
  }
  return null;
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Image generation routinely runs 15-60s and multi-reference blends can exceed
 * a minute, which trips the 60s default request timeout in most MCP clients.
 * Emitting periodic progress notifications lets a client reset that timer
 * (SDK clients do so with `resetTimeoutOnProgress`). No-ops when the caller
 * did not supply a progress token. `label` may be a function so a batch can
 * report how many prompts have finished.
 */
async function withProgress<T>(
  extra: ToolExtra,
  label: string | (() => string),
  fn: () => Promise<T>,
): Promise<T> {
  const progressToken = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (progressToken === undefined || typeof send !== "function") return fn();

  const startedAt = Date.now();
  let ticks = 0;
  const timer = setInterval(() => {
    ticks++;
    const secs = Math.round((Date.now() - startedAt) / 1000);
    void send({
      method: "notifications/progress",
      params: {
        progressToken,
        progress: ticks,
        message: `${typeof label === "function" ? label() : label} - ${secs}s elapsed`,
      },
    }).catch(() => {
      /* A dropped heartbeat must never fail the generation itself. */
    });
  }, 5000);
  timer.unref?.();

  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

/**
 * Runs a billed call and measures what it actually cost, by reading cumulative
 * account usage before and after.
 *
 * The reading is account-wide, so anything else spending on the same account
 * concurrently inflates the delta; it is reported as measured rather than
 * derived precisely because the published price formula does not reproduce the
 * real charge. A null result means the usage endpoint was unavailable.
 */
async function withCost<T>(fn: () => Promise<T>): Promise<{ value: T; costUsd: number | null }> {
  const before = await client.usageUsd();
  const value = await fn();
  const after = before === null ? null : await client.usageUsd();
  const costUsd = before !== null && after !== null ? Math.max(0, after - before) : null;
  return { value, costUsd };
}

/** Minimal semaphore - batch work is IO-bound, so a dependency isn't warranted. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const server = new McpServer({ name: "pro-image-mcp", version: "0.1.0" });

server.registerTool(
  "image_generate",
  {
    title: "Generate image from text",
    description:
      "Text-to-image via /v1/images/generations. quality and size are required because both affect billing. " +
      "Images are saved to disk and only the file path is returned - image bytes are never inlined into context.",
    inputSchema: {
      prompt: z.string().min(1).describe("What to draw."),
      quality: QualityArg,
      size: SizeArg,
      model: ModelArg,
      n: z.number().int().min(1).max(4).optional().describe("Image count (default 1). Each image is billed separately."),
      save_dir: SaveDirArg,
    },
  },
  async ({ prompt, quality, size, model, n, save_dir }, extra) => {
    const m = model?.trim() || cfg.defaultModel;
    const pre = preflight(quality, size, m);
    if (pre.error) return fail(pre.error);
    try {
      const { value, costUsd } = await withProgress(extra, `generating with ${m}`, () =>
        withCost(async () => {
          const res = await client.generate({ model: m, prompt, size, quality, n: n ?? 1, response_format: "url" });
          return { res, saved: await saveImages(client, cfg, res, m, save_dir) };
        }),
      );
      const { res, saved } = value;
      return text(
        withWarnings(
          formatResult({ model: m, requestedQuality: quality, requestedSize: size, meta: res._meta, saved, costUsd }),
          pre.warnings,
        ),
      );
    } catch (e) {
      return fail(explainSizeError(describeError(e), size, m) ?? describeError(e));
    }
  },
);

server.registerTool(
  "image_edit",
  {
    title: "Edit an image with a prompt",
    description:
      "Image-to-image via /v1/images/edits with one reference image. quality and size are required (both affect billing). " +
      "Masks are accepted by the endpoint but ignored by the provider, so this tool does not expose one.",
    inputSchema: {
      image_path: z.string().describe("Absolute path to the source image (png/jpg/webp/gif)."),
      prompt: z.string().min(1).describe("How to change the image."),
      quality: QualityArg,
      size: SizeArg,
      model: ModelArg,
      save_dir: SaveDirArg,
    },
  },
  async ({ image_path, prompt, quality, size, model, save_dir }, extra) => {
    const m = model?.trim() || cfg.defaultModel;
    const pre = preflight(quality, size, m);
    if (pre.error) return fail(pre.error);
    const missing = await assertReadable([image_path]);
    if (missing) return fail(missing);
    try {
      const { value, costUsd } = await withProgress(extra, `editing with ${m}`, () =>
        withCost(async () => {
          const res = await client.edit([image_path], { model: m, prompt, size, quality, n: "1" });
          return { res, saved: await saveImages(client, cfg, res, `${m}-edit`, save_dir) };
        }),
      );
      const { res, saved } = value;
      return text(
        withWarnings(
          formatResult({ model: m, requestedQuality: quality, requestedSize: size, meta: res._meta, saved, costUsd }),
          pre.warnings,
        ),
      );
    } catch (e) {
      return fail(explainSizeError(describeError(e), size, m) ?? describeError(e));
    }
  },
);

server.registerTool(
  "image_multi_reference",
  {
    title: "Blend 2-10 reference images",
    description:
      "Combines multiple reference images into one via /v1/images/edits using repeated image[] fields. " +
      "quality and size are required (both affect billing). Confirm the model supports image input via list_models.",
    inputSchema: {
      image_paths: z.array(z.string()).min(2).max(10).describe("2-10 absolute paths to reference images."),
      prompt: z.string().min(1).describe("How to combine the references."),
      quality: QualityArg,
      size: SizeArg,
      model: ModelArg,
      save_dir: SaveDirArg,
    },
  },
  async ({ image_paths, prompt, quality, size, model, save_dir }, extra) => {
    const m = model?.trim() || cfg.defaultModel;
    const pre = preflight(quality, size, m);
    if (pre.error) return fail(pre.error);
    const missing = await assertReadable(image_paths);
    if (missing) return fail(missing);
    try {
      const { value, costUsd } = await withProgress(extra, `blending ${image_paths.length} refs with ${m}`, () =>
        withCost(async () => {
          const res = await client.edit(image_paths, { model: m, prompt, size, quality, n: "1" });
          return { res, saved: await saveImages(client, cfg, res, `${m}-multiref`, save_dir) };
        }),
      );
      const { res, saved } = value;
      const body = formatResult({
        model: m,
        requestedQuality: quality,
        requestedSize: size,
        meta: res._meta,
        saved,
        costUsd,
      });
      const uploaded = res._meta?.references_uploaded;
      const note =
        uploaded !== undefined && uploaded !== image_paths.length
          ? `\n\nWARNING: sent ${image_paths.length} references but the API reported references_uploaded=${uploaded}.`
          : "";
      return text(withWarnings(body + note, pre.warnings));
    } catch (e) {
      return fail(explainSizeError(describeError(e), size, m) ?? describeError(e));
    }
  },
);

server.registerTool(
  "image_batch_generate",
  {
    title: "Generate many images from many prompts",
    description:
      "Runs image_generate over a list of prompts with bounded concurrency. Every prompt is billed separately - " +
      "the total is reported at the end. Failures do not abort the batch; they are listed per prompt.",
    inputSchema: {
      prompts: z.array(z.string().min(1)).min(1).max(20).describe("Up to 20 prompts. Each costs one image."),
      quality: QualityArg,
      size: SizeArg,
      model: ModelArg,
      concurrency: z
        .number()
        .int()
        .min(1)
        .max(8)
        .optional()
        .describe(`Parallel requests (default ${cfg.maxConcurrency}).`),
      save_dir: SaveDirArg,
    },
  },
  async ({ prompts, quality, size, model, concurrency, save_dir }, extra) => {
    const m = model?.trim() || cfg.defaultModel;
    const pre = preflight(quality, size, m);
    if (pre.error) return fail(pre.error);
    const limit = Math.min(concurrency ?? cfg.maxConcurrency, 8);

    let done = 0;
    const { value: outcomes, costUsd } = await withProgress(
      extra,
      () => `${m} batch: ${done}/${prompts.length} done`,
      () =>
        withCost(() =>
          mapLimit(prompts, limit, async (prompt, i) => {
      try {
        const res: ImageResponse = await client.generate({
          model: m,
          prompt,
          size,
          quality,
          n: 1,
          response_format: "url",
        });
        const saved = await saveImages(client, cfg, res, `${m}-batch${i + 1}`, save_dir);
        return { i, ok: true as const, prompt, credits: res._meta?.credits_charged ?? 0, saved, meta: res._meta };
      } catch (e) {
        return { i, ok: false as const, prompt, error: describeError(e) };
      } finally {
        done++;
      }
          }),
        ),
    );

    const okCount = outcomes.filter((o) => o.ok).length;
    const credits = outcomes.reduce((sum, o) => sum + (o.ok ? o.credits : 0), 0);
    const lines = [
      `Batch complete: ${okCount}/${prompts.length} succeeded.`,
      `model=${m}  quality=${quality}  size=${size}  concurrency=${limit}`,
      costUsd === null
        ? `upstream_credits=${credits}  (cost unavailable: the usage endpoint did not respond)`
        : `total_cost=$${costUsd.toFixed(5)}  upstream_credits=${credits}`,
      "",
    ];
    for (const o of outcomes) {
      const head = `[${o.i + 1}] ${o.prompt.slice(0, 60)}${o.prompt.length > 60 ? "..." : ""}`;
      if (o.ok) {
        const paths = o.saved.map((s) => s.path).join(", ") || "(no image returned)";
        const gen = o.meta?.generation_size;
        const target = o.meta?.target_size;
        const up = gen && target && gen !== target ? `  [rendered ${gen}, upscaled to ${target}]` : "";
        lines.push(`${head}\n    OK -> ${paths}${up}`);
      } else {
        lines.push(`${head}\n    FAILED: ${o.error}`);
      }
    }
    const body = withWarnings(lines.join("\n"), pre.warnings);
    return okCount === 0 ? fail(body) : text(body);
  },
);

server.registerTool(
  "list_models",
  {
    title: "List image models with capabilities and estimated prices",
    description:
      "Merges /v1/models (what this key can reach) with /api/pricing (price, description and SKU multipliers). " +
      "Reports, per model, whether it accepts image input (image_edit / image_multi_reference) and what one image " +
      "costs at a given size and quality, so a model can be chosen on capability and cost rather than guesswork.",
    inputSchema: {
      filter: z.string().optional().describe("Case-insensitive substring to match against model id."),
      size: z
        .string()
        .optional()
        .describe(`Price the models for this size (default 1024x1024). Long edge picks the tier: <=1024, <=2048, <=3072, above.`),
      quality: z
        .enum(QUALITY_VALUES)
        .optional()
        .describe("Price the models for this quality (default low). Only affects models carrying a quality SKU rule."),
      supports: z
        .enum(["any", "image_to_image", "text_to_image_only"])
        .optional()
        .describe("Filter by capability. Use image_to_image before calling image_edit or image_multi_reference."),
    },
  },
  async ({ filter, size, quality, supports }) => {
    const forSize = size?.trim() || "1024x1024";
    const forQuality = quality ?? "low";
    try {
      const [models, pricing] = await Promise.all([client.listModels(), client.pricing().catch(() => [])]);
      const byName = new Map(pricing.map((p) => [p.model_name, p]));
      const needle = filter?.trim().toLowerCase();

      let rows = models
        .filter((m) => !needle || m.id.toLowerCase().includes(needle))
        .map((m) => {
          const p = byName.get(m.id);
          return { m, p, cap: deriveCapability(p), est: estimatePrice(p, forSize, forQuality) };
        });

      if (supports === "image_to_image") {
        rows = rows.filter((r) => r.cap.imageToImage === "verified" || r.cap.imageToImage === "likely");
      } else if (supports === "text_to_image_only") {
        rows = rows.filter((r) => r.cap.imageToImage === "unlikely");
      }

      rows.sort((a, b) => (a.est.usd ?? Infinity) - (b.est.usd ?? Infinity) || a.m.id.localeCompare(b.m.id));
      if (!rows.length) return text(`No models matched filter=${JSON.stringify(filter ?? "")} supports=${supports ?? "any"}.`);

      const lines = [
        `${rows.length} model(s) reachable with this key, cheapest first.`,
        `LIST prices per image at size=${forSize} quality=${forQuality}, computed from the relay's published ` +
          `price and SKU rules. Treat them as relative guidance, not as the bill: measured charges have come in ` +
          `at about half the computed figure, by a factor the published group ratios do not explain. The ` +
          `generation tools report the real cost, measured from account usage. Channel groups pick the upstream ` +
          `source, are fixed by the key, and are a separate axis from the per-request quality parameter.`,
        "",
      ];
      for (const { m, p, cap, est } of rows) {
        lines.push(`${m.id}  ${formatUsd(est.usd)}`);
        lines.push(`    list price: ${est.breakdown}`);
        lines.push(`    image input: ${describeSupport(cap.imageToImage)} - ${cap.reason}`);
        if (p?.description) lines.push(`    ${p.description.slice(0, 150)}`);
      }
      lines.push(
        "",
        "Capability notes: the relay exposes no capability flag (every image model is tagged 图像 and " +
          "supported_endpoint_types does not correlate), so anything not marked (verified) is inferred from the " +
          "vendor's own description and may be wrong. Run scripts/probe-capabilities.mjs to confirm by live call.",
        `Valid sizes: ${SIZE_EXAMPLES.join(", ")}, or auto.`,
        `Valid quality: ${QUALITY_VALUES.join(", ")}.`,
      );
      return text(lines.join("\n"));
    } catch (e) {
      return fail(describeError(e));
    }
  },
);

server.registerTool(
  "server_info",
  {
    title: "Show configuration, balance and API constraints",
    description: "Reports the active configuration, the account balance, and the verified quirks of this relay.",
    inputSchema: {},
  },
  async () => {
    const [billing, usedUsd] = await Promise.all([client.billing(), client.usageUsd()]);
    const quota = billing?.hard_limit_usd;
    const lines = [
      "pro-image-mcp 0.1.0",
      "",
      "Configuration",
      `  base_url:      ${cfg.baseUrl}`,
      `  api_key:       ${cfg.apiKey.slice(0, 6)}...${cfg.apiKey.slice(-4)}`,
      `  default_model: ${cfg.defaultModel}`,
      `  save_dir:      ${cfg.saveDir}`,
      `  timeout_ms:    ${cfg.timeoutMs}`,
      `  concurrency:   ${cfg.maxConcurrency}`,
      "",
      "Account",
      // hard_limit_usd is a quota ceiling and does not move as calls are billed;
      // spend has to come from the usage endpoint instead.
      quota !== undefined ? `  quota limit: $${quota.toFixed(4)}` : "  quota limit: unavailable",
      usedUsd !== null ? `  used so far:  $${usedUsd.toFixed(4)}` : "  used so far:  unavailable",
      quota !== undefined && usedUsd !== null ? `  remaining:    $${(quota - usedUsd).toFixed(4)}` : "",
      "",
      "Required per-request parameters",
      `  quality: ${QUALITY_VALUES.join(" | ")}  (render quality; also prices gpt-image-2 / gpt-image-1-5)`,
      `  size:    ${SIZE_EXAMPLES.join(", ")}, or auto`,
      "  Neither is defaulted, because both can change what a call costs.",
      "  The key's channel group (which upstream source serves the call) is a separate axis, fixed by the key,",
      "  and is NOT the quality parameter.",
      "",
      "Verified API constraints",
      "  - Only aspect ratios 1:1, 3:4, 4:3, 9:16, 16:9 are accepted. 1536x1024 (3:2) fails with HTTP 500;",
      "    use 1792x1024 for landscape. Sizes are validated locally before any request is billed.",
      "  - The API does NOT validate `quality` and echoes back whatever it is sent, so a typo would bill at an",
      "    unknown tier. This server whitelists the value instead.",
      "  - `size_downgraded` is unreliable: 4096x4096 renders at 1360x1360 and is upscaled while the flag stays",
      "    false. Downgrades are detected by comparing generation_size against target_size.",
      "  - Returned image URLs carry a leading space, which is stripped before download.",
      "  - Masks are accepted by /v1/images/edits but ignored upstream.",
      "  - b64_json responses reach ~15MB at 2048x2048, so images are always saved to disk and only paths returned.",
    ];
    return text(lines.join("\n"));
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stdout is the MCP channel; diagnostics must go to stderr.
console.error(`pro-image-mcp ready - ${cfg.baseUrl}, saving to ${cfg.saveDir}`);
