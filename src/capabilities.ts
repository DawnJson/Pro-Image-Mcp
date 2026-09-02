import type { PricingEntry } from "./client.js";

export type Support = "verified-yes" | "verified-no" | "likely" | "unlikely" | "unknown";

export interface ModelCapability {
  imageToImage: Support;
  /** Why imageToImage got the value it did, for display. */
  reason: string;
  /** Maximum reference images the model family accepts, when known. */
  maxReferences?: number;
}

/**
 * Whether a reference image is actually USED, measured on this relay.
 *
 * The reliable signal is the `model` field of an edits response, which the relay
 * suffixes with the pipeline it really ran: `nano-banana:image2image` means the
 * reference was applied, while `z-image:text2image` means the upload was
 * accepted and then discarded. `_meta.references_uploaded` only reports that
 * bytes arrived and is 1 in both cases, so it must never be used for this.
 *
 * IMPORTANT: these results are a property of the CHANNEL GROUP this key belongs
 * to, not of the models. They were measured on a 图像-低 key, which the relay
 * describes as "聚合/逆向渠道, 质量参差, 功能受限". A 图像-高 key routes to
 * official endpoints with full parameter passthrough and would plausibly give
 * different answers, so re-run the probe after switching keys.
 *
 * Regenerate with `node scripts/probe-capabilities.mjs --confirm`, which bills
 * one edit per model and reads the same suffix.
 */
const MEASURED_IMAGE_TO_IMAGE: Record<string, boolean> = {
  // Only four of the twenty models this key can reach actually apply a
  // reference. Everything else accepted the upload, ran text2image, and billed.
  "gpt-image-2": true,
  "nano-banana": true,
  "qwen-image-2": true,
  "wan2-7-image": true,

  "byte-plus-seedream-4": false,
  "byte-plus-seedream-4-5": false,
  "byte-plus-seedream-5-lite": false,
  "flux-1-1-pro": false,
  "flux-1-dev": false,
  "flux-2-klein-9b": false,
  "flux-2-lora-gallery-realism": false,
  "flux-2-max": false,
  "flux-2-pro": false,
  // Named for multi-image context and still ran text2image here.
  "flux-kontext-max": false,
  "flux-kontext-pro": false,
  "gpt-image-1-5": false,
  "juggernaut-flux-pro": false,
  "qwen-image-max": false,
  "qwen-image-plus": false,
  "z-image": false,
};

/**
 * Family priors taken from prolab, the relay operator's own image front end
 * (`image-body-builder.ts` detectModelFamily, `registry.ts` IMAGE_MODEL_REGISTRY).
 * Order matters: the first matching pattern wins, most specific first.
 *
 * A positive here is a decent prior: prolab actually builds and ships that
 * request. A negative is much weaker - prolab's registry omits the capability
 * rather than denying it, so "prolab does not do this" and "the model cannot do
 * this" are indistinguishable. Negatives therefore surface as "unknown", not as
 * "probably no", and only a live measurement can rule a model out.
 *
 * Measurement has since shown the prior to be badly optimistic on this relay's
 * 图像-低 channel: prolab classifies flux (including flux-kontext, named for
 * multi-image context) and seedream as accepting references, and all eleven of
 * those models measurably ignore them. Treat a positive prior as "worth
 * measuring", never as an answer.
 */
const FAMILY_PRIORS: ReadonlyArray<{
  family: string;
  pattern: RegExp;
  imageToImage: boolean;
  maxReferences?: number;
}> = [
  { family: "dalle", pattern: /^dall-e-/, imageToImage: false },
  { family: "gpt-image", pattern: /^gpt-image/, imageToImage: true, maxReferences: 16 },
  { family: "gpt4o-image", pattern: /^gpt-4o/, imageToImage: true },
  { family: "flux", pattern: /^flux/, imageToImage: true, maxReferences: 8 },
  { family: "grok-imagine", pattern: /grok-imagine/, imageToImage: true, maxReferences: 3 },
  { family: "imagen", pattern: /^(google-)?imagen/, imageToImage: true },
  { family: "nano-banana", pattern: /nano-banana|gemini.*image/, imageToImage: true },
  { family: "seedream", pattern: /^(byte-plus-|doubao-)?seedream/, imageToImage: true, maxReferences: 10 },
  { family: "qwen", pattern: /^(qwen-image|wan)/, imageToImage: true, maxReferences: 3 },
  { family: "z-image", pattern: /^z-image/, imageToImage: false },
  { family: "sora-image", pattern: /sora.?image/, imageToImage: true },
  { family: "agnes-image", pattern: /^agnes-image/, imageToImage: false },
  { family: "hunyuan-image", pattern: /^hunyuan.*image/, imageToImage: false },
];

export function detectFamily(model: string): string {
  return FAMILY_PRIORS.find((f) => f.pattern.test(model))?.family ?? "unknown";
}

export function deriveCapability(entry: PricingEntry | undefined, modelId?: string): ModelCapability {
  const name = modelId ?? entry?.model_name ?? "";
  const prior = FAMILY_PRIORS.find((f) => f.pattern.test(name));

  const measured = MEASURED_IMAGE_TO_IMAGE[name];
  if (measured !== undefined) {
    return {
      imageToImage: measured ? "verified-yes" : "verified-no",
      reason: measured
        ? "a live edits call came back as :image2image"
        : "a live edits call came back as :text2image - the reference was accepted and then ignored",
      maxReferences: prior?.maxReferences,
    };
  }

  if (prior?.imageToImage) {
    return {
      imageToImage: "likely",
      reason: `prolab, the relay's own front end, sends reference images for the "${prior.family}" family`,
      maxReferences: prior.maxReferences,
    };
  }
  if (prior) {
    return {
      imageToImage: "unknown",
      reason: `prolab does not send reference images for the "${prior.family}" family, but it never states the model cannot accept them - measure it before relying on either answer`,
    };
  }

  // Vendor descriptions are the weakest signal: z-image is described as a
  // "文生图/图生图" model and measurably does not use references.
  const desc = entry?.description ?? "";
  if (/图生图|图像编辑|图片编辑|多图上下文|参考图/.test(desc)) {
    return { imageToImage: "unknown", reason: "only the vendor description suggests image input, which has proven unreliable" };
  }
  return { imageToImage: "unknown", reason: "no family match and no usable description" };
}

const MARK: Record<Support, string> = {
  "verified-yes": "YES (measured)",
  "verified-no": "NO (measured - reference silently ignored)",
  likely: "probably yes (prolab family)",
  unlikely: "probably no (prolab family)",
  unknown: "unknown",
};

export function describeSupport(s: Support): string {
  return MARK[s];
}

/**
 * Detects, from an edits response, whether the reference images were actually
 * applied. Returns a warning when they were not - a silent no-op that still
 * bills and still returns a plausible image is the worst failure mode here.
 */
export function referenceIgnoredWarning(responseModel: string | undefined, referenceCount: number): string | null {
  if (!responseModel) return null;
  if (!responseModel.includes(":text2image")) return null;
  return (
    `The ${referenceCount === 1 ? "reference image was" : `${referenceCount} reference images were`} uploaded but NOT used: ` +
    `the relay ran "${responseModel}", a text-to-image pipeline. The result is generated from the prompt alone, ` +
    `and you were still billed. Pick a model whose image input is measured, such as nano-banana ` +
    `(list_models with supports="image_to_image").`
  );
}
