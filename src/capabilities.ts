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
 * Extend with `node scripts/probe-capabilities.mjs`, which bills one edit per
 * model and reads the same suffix.
 */
const MEASURED_IMAGE_TO_IMAGE: Record<string, boolean> = {
  "nano-banana": true,
  // Uploaded 2 references and still ran text2image.
  "byte-plus-seedream-4-5": false,
  // Uploaded 1 reference and still ran text2image, matching prolab's registry,
  // which marks z-image as having no reference-image support at all.
  "z-image": false,
};

/**
 * Family priors taken from prolab, the relay operator's own image front end
 * (`image-body-builder.ts` detectModelFamily, `registry.ts` IMAGE_MODEL_REGISTRY).
 * Order matters: the first matching pattern wins, most specific first.
 *
 * These describe what the upstream models can do, which is a strong prior but
 * not proof for THIS relay - it resells aggregated and reverse-engineered
 * channels whose behaviour can differ, as seedream-4-5 already shows.
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

  if (prior) {
    return {
      imageToImage: prior.imageToImage ? "likely" : "unlikely",
      reason: `model family "${prior.family}" ${prior.imageToImage ? "accepts" : "does not accept"} reference images in prolab, the relay's own front end`,
      maxReferences: prior.maxReferences,
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
