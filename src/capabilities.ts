import type { PricingEntry } from "./client.js";

export type Support = "verified" | "likely" | "unlikely" | "unknown";

export interface ModelCapability {
  textToImage: Support;
  imageToImage: Support;
  /** Why imageToImage got the value it did, for display. */
  reason: string;
}

/**
 * Models confirmed by an actual /v1/images/edits round trip against the relay.
 * The upstream metadata carries no capability flag (`tags` is "图像" for every
 * image model and `supported_endpoint_types` does not correlate: nano-banana
 * does image-to-image while listing only "openai", and flux-1-dev lists
 * "image-generation" while being text-to-image only), so anything not in here
 * is inferred from the vendor description instead.
 *
 * Extend this by running `node scripts/probe-capabilities.mjs`, which bills one
 * edit per model.
 */
const VERIFIED_IMAGE_TO_IMAGE: Record<string, boolean> = {
  "nano-banana": true,
  "byte-plus-seedream-4-5": true,
  "byte-plus-seedream-5-lite": true,
};

/** Vendor descriptions are Chinese; these are the phrases that imply image input. */
const I2I_MARKERS = ["图生图", "图像编辑", "图片编辑", "多图上下文", "参考图", "image edit", "image-to-image"];
const T2I_MARKERS = ["文生图", "图像生成", "text-to-image"];

export function deriveCapability(entry: PricingEntry | undefined): ModelCapability {
  const name = entry?.model_name ?? "";
  const desc = entry?.description ?? "";

  const verified = VERIFIED_IMAGE_TO_IMAGE[name];
  if (verified !== undefined) {
    return {
      textToImage: "verified",
      imageToImage: verified ? "verified" : "unlikely",
      reason: "confirmed by a live /v1/images/edits call",
    };
  }

  if (!desc) {
    return { textToImage: "likely", imageToImage: "unknown", reason: "no vendor description available" };
  }

  const hit = I2I_MARKERS.find((m) => desc.includes(m));
  if (hit) {
    return { textToImage: "likely", imageToImage: "likely", reason: `vendor description mentions "${hit}"` };
  }
  if (T2I_MARKERS.some((m) => desc.includes(m))) {
    return {
      textToImage: "likely",
      imageToImage: "unlikely",
      reason: "vendor description names text-to-image only",
    };
  }
  return { textToImage: "likely", imageToImage: "unknown", reason: "vendor description is inconclusive" };
}

const MARK: Record<Support, string> = {
  verified: "yes (verified)",
  likely: "yes (from description)",
  unlikely: "no (from description)",
  unknown: "unknown",
};

export function describeSupport(s: Support): string {
  return MARK[s];
}
