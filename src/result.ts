import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { ImageMeta, ImageResponse, RelayClient } from "./client.js";
import { resolveSaveDir, sniffImage } from "./paths.js";

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "image";
}

export interface SavedImage {
  path: string;
  bytes: number;
  width?: number;
  height?: number;
  sourceUrl?: string;
}

/** PNG dimensions live in the IHDR chunk; other formats are left unreported. */
function pngSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length < 24 || buf.subarray(1, 4).toString("latin1") !== "PNG") return undefined;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export async function saveImages(
  client: RelayClient,
  cfg: Config,
  res: ImageResponse,
  label: string,
  saveDirOverride?: string,
): Promise<SavedImage[]> {
  const dir = resolveSaveDir(cfg, saveDirOverride);
  await mkdir(dir, { recursive: true });

  const out: SavedImage[] = [];
  const items = res.data ?? [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    let buf: Buffer;
    let sourceUrl: string | undefined;

    if (item.url) {
      sourceUrl = item.url.trim(); // The API emits a leading space in this field.
      buf = await client.download(sourceUrl);
    } else if (item.b64_json) {
      buf = Buffer.from(item.b64_json, "base64");
    } else {
      continue;
    }

    const suffix = items.length > 1 ? `-${i + 1}` : "";
    // The extension has to match the bytes, not whatever the URL claimed.
    const kind = sniffImage(buf);
    const ext = kind === "jpeg" ? ".jpg" : kind ? `.${kind}` : ".png";
    const path = join(dir, `${stamp()}-${slug(label)}${suffix}${ext}`);
    await writeFile(path, buf);
    const dim = pngSize(buf);
    out.push({ path, bytes: buf.length, width: dim?.width, height: dim?.height, sourceUrl });
  }
  return out;
}

function human(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`;
}

/**
 * Builds the audit block. Two upstream quirks are surfaced loudly here:
 * the echoed `quality_used` may differ from what was requested, and
 * `generation_size` can be below `target_size` (upscaled after the fact)
 * while the API's own `size_downgraded` flag still reads false.
 */
export function formatResult(opts: {
  model: string;
  requestedQuality: string;
  requestedSize: string;
  meta?: ImageMeta;
  saved: SavedImage[];
  /** Measured USD delta around the call, or null when unavailable. */
  costUsd?: number | null;
  /** False when the model's family does not accept `quality`, so it was not transmitted. */
  qualitySent?: boolean;
}): string {
  const { model, requestedQuality, requestedSize, meta = {}, saved, costUsd, qualitySent = true } = opts;
  const lines: string[] = [];
  const warnings: string[] = [];

  lines.push(
    `model=${model}  quality=${requestedQuality}${qualitySent ? "" : " (not sent)"}  size=${requestedSize}`,
  );

  const billed: string[] = [];
  if (costUsd !== undefined && costUsd !== null) billed.push(`cost=$${costUsd.toFixed(5)}`);
  // Upstream provider credits, not USD - kept for provenance, never as the price.
  if (meta.credits_charged !== undefined) billed.push(`upstream_credits=${meta.credits_charged}`);
  if (meta.quality_used !== undefined) billed.push(`quality_used=${meta.quality_used}`);
  if (meta.attempts !== undefined && meta.attempts > 1) billed.push(`attempts=${meta.attempts}`);
  if (billed.length) lines.push(billed.join("  "));

  // Only a real mismatch when the value was actually sent; when the family does
  // not accept quality, the caller already gets a note explaining the omission.
  if (qualitySent && meta.quality_used && meta.quality_used !== requestedQuality) {
    warnings.push(`Requested quality "${requestedQuality}" but the API billed "${meta.quality_used}".`);
  }

  const gen = meta.generation_size;
  const target = meta.target_size;
  if (gen && target) {
    lines.push(gen === target ? `rendered ${gen}` : `rendered ${gen} -> upscaled to ${target}`);
    if (gen !== target) {
      warnings.push(
        `Paid for ${target} but the model only rendered ${gen}; the rest is upscaling, not detail. ` +
          `(The API's own size_downgraded flag reads ${meta.size_downgraded} here and cannot be trusted.)`,
      );
    }
  }
  if (meta.downgraded) warnings.push("The API reported downgraded=true for this request.");
  if (meta.mask_received_but_ignored) warnings.push("A mask was sent but the upstream provider ignored it.");
  if (meta.references_uploaded !== undefined) lines.push(`references_uploaded=${meta.references_uploaded}`);

  for (const s of saved) {
    const dim = s.width && s.height ? ` (${s.width}x${s.height}, ${human(s.bytes)})` : ` (${human(s.bytes)})`;
    lines.push(`saved: ${s.path}${dim}`);
  }
  if (!saved.length) warnings.push("The API returned no image data.");

  if (warnings.length) {
    lines.push("");
    for (const w of warnings) lines.push(`WARNING: ${w}`);
  }
  return lines.join("\n");
}
