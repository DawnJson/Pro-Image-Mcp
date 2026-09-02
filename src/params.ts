import { detectFamily } from "./capabilities.js";

/**
 * Which request fields each model family actually accepts.
 *
 * Transcribed from the relay operator's own image web client, which sends a
 * different field set per family rather than one union. Sending a field a family
 * does not accept is not obviously harmful on this relay (it returns 200 either
 * way), but it is misleading: the caller believes they turned a knob that is not
 * connected to anything. So a field outside the family's set is dropped from the
 * wire and reported.
 *
 * `unknown` is deliberately permissive - for an unrecognised model, passing the
 * caller's fields through is better than silently discarding them.
 */
const FAMILY_FIELDS: Record<string, ReadonlySet<string>> = {
  dalle: new Set(["size", "style"]),
  "gpt-image": new Set([
    "size",
    "quality",
    "background",
    "output_format",
    "output_compression",
    "moderation",
    "input_fidelity",
  ]),
  "gpt4o-image": new Set(["size", "quality", "background"]),
  flux: new Set(["size", "seed", "output_format"]),
  "grok-imagine": new Set(["resolution"]),
  imagen: new Set(["size", "seed"]),
  "nano-banana": new Set(["size"]),
  seedream: new Set(["size", "quality", "seed", "negative_prompt", "watermark"]),
  qwen: new Set(["size", "seed", "negative_prompt", "watermark", "prompt_extend"]),
  "z-image": new Set(["negative_prompt"]),
  "sora-image": new Set(["size"]),
  "agnes-image": new Set([]),
  "hunyuan-image": new Set(["size", "quality"]),
  unknown: new Set([
    "size",
    "quality",
    "seed",
    "negative_prompt",
    "watermark",
    "background",
    "output_format",
    "input_fidelity",
  ]),
};

/** Optional, family-specific fields a caller may supply. */
export interface ExtraParams {
  seed?: number;
  negative_prompt?: string;
  input_fidelity?: string;
  background?: string;
  output_format?: string;
  watermark?: boolean;
}

export interface BuiltBody {
  /** Fields to send, already filtered to what the family accepts. */
  fields: Record<string, string | number | boolean>;
  /** Human-readable notes about fields that were dropped. */
  notes: string[];
}

/**
 * Assembles the request fields for a model, keeping only what its family takes.
 *
 * `size` is always offered because callers must pass one; `quality` likewise,
 * even though several families ignore it - dropping it quietly is exactly the
 * kind of invisible no-op this module exists to prevent.
 */
export function buildParams(
  model: string,
  base: { size: string; quality: string },
  extra: ExtraParams = {},
): BuiltBody {
  const family = detectFamily(model);
  const allowed = FAMILY_FIELDS[family] ?? FAMILY_FIELDS.unknown;
  const fields: Record<string, string | number | boolean> = {};
  const dropped: string[] = [];

  const offer = (name: string, value: string | number | boolean | undefined) => {
    if (value === undefined || value === "") return;
    if (allowed.has(name)) fields[name] = value;
    else dropped.push(name);
  };

  // "auto" means "say nothing about size", not a literal value to transmit.
  if (base.size !== "auto") offer("size", base.size);
  offer("quality", base.quality);
  // -1 is the relay's "random" sentinel and is never transmitted.
  offer("seed", extra.seed !== undefined && extra.seed >= 0 ? extra.seed : undefined);
  offer("negative_prompt", extra.negative_prompt);
  offer("input_fidelity", extra.input_fidelity);
  offer("background", extra.background === "auto" ? undefined : extra.background);
  offer("output_format", extra.output_format);
  offer("watermark", extra.watermark);

  const notes: string[] = [];
  if (dropped.length) {
    notes.push(
      `${dropped.join(", ")} ${dropped.length === 1 ? "was" : "were"} NOT sent: the "${family}" family does not ` +
        `accept ${dropped.length === 1 ? "it" : "them"}. ` +
        `${dropped.includes("quality") ? "quality is required by this tool for billing safety, but has no effect on this model. " : ""}` +
        `The request was made without ${dropped.length === 1 ? "it" : "them"}.`,
    );
  }
  return { fields, notes };
}

/** Families where `quality` reaches the model at all. */
export function qualityApplies(model: string): boolean {
  const family = detectFamily(model);
  return (FAMILY_FIELDS[family] ?? FAMILY_FIELDS.unknown).has("quality");
}
