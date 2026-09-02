/**
 * The relay advertises pixel sizes but the upstream provider only accepts a
 * fixed set of aspect ratios. A WxH whose ratio is not one of these comes back
 * as an HTTP 500 after the full generation wait, so we reject it locally.
 * Verified against the live API: 1536x1024 (3:2) is rejected, 1024x1792 (~9:16)
 * is accepted.
 */
export const ALLOWED_RATIOS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "9:16", value: 9 / 16 },
  { label: "3:4", value: 3 / 4 },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
];

/** 1024x1792 is 1.6% off exact 9:16 and is accepted upstream, so allow ~6%. */
const RATIO_TOLERANCE = 0.06;

export const SIZE_EXAMPLES = [
  "1024x1024 (1:1)",
  "768x1024 (3:4)",
  "1024x768 (4:3)",
  "1024x1792 (9:16)",
  "1792x1024 (16:9)",
];

export const QUALITY_VALUES = ["low", "medium", "high"] as const;
export type Quality = (typeof QUALITY_VALUES)[number];

export interface SizeCheck {
  ok: boolean;
  ratioLabel?: string;
  error?: string;
}

export function validateSize(size: string): SizeCheck {
  if (size === "auto") return { ok: true, ratioLabel: "auto" };

  const m = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!m) {
    return { ok: false, error: `size must be "WxH" (e.g. 1024x1024) or "auto", got ${JSON.stringify(size)}.` };
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w <= 0 || h <= 0) return { ok: false, error: `size must have positive dimensions, got ${size}.` };

  const ratio = w / h;
  let best = ALLOWED_RATIOS[0];
  let bestErr = Infinity;
  for (const cand of ALLOWED_RATIOS) {
    const err = Math.abs(ratio - cand.value) / cand.value;
    if (err < bestErr) {
      bestErr = err;
      best = cand;
    }
  }
  if (bestErr > RATIO_TOLERANCE) {
    return {
      ok: false,
      error:
        `size ${size} has aspect ratio ${ratio.toFixed(3)}, which the upstream provider rejects. ` +
        `Only 1:1, 3:4, 4:3, 9:16, 16:9 (and "auto") are accepted. ` +
        `Try one of: ${SIZE_EXAMPLES.join(", ")}.`,
    };
  }
  return { ok: true, ratioLabel: best.label };
}

/**
 * The API echoes back whatever quality string it is given (it accepted "ultra"
 * in testing and billed at an undocumented tier), so validation has to happen
 * here or a typo silently changes what the user pays.
 */
export function validateQuality(quality: string): string | null {
  return (QUALITY_VALUES as readonly string[]).includes(quality)
    ? null
    : `quality must be one of ${QUALITY_VALUES.join(", ")}, got ${JSON.stringify(quality)}. ` +
        `The upstream API does NOT validate this field and will bill at an unknown tier for typos.`;
}
