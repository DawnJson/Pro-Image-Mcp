/**
 * Size and quality validation.
 *
 * The relay accepts a pixel "WxH" and maps it to an aspect ratio upstream, but
 * WHICH ratios are accepted is per-model, not global: z-image rejects 3:2 with
 * `expected one of "1:1"|"3:4"|"4:3"|"9:16"|"16:9"|"auto"`, while gpt-image-2
 * accepts both 3:2 (1536x1024) and 21:9 (2016x864). Both facts are from live
 * calls.
 *
 * A rejected size costs no money - only the wait - so blocking a size the model
 * would have accepted is worse than letting a doomed request through. Only
 * models proven restrictive are pre-blocked; everything else is passed to the
 * API, and the upstream error is rewritten into something actionable.
 */

/** Ratios accepted by the models in RESTRICTED_RATIO_MODELS. */
export const RESTRICTED_RATIOS: ReadonlyArray<{ label: string; value: number }> = [
  { label: "9:16", value: 9 / 16 },
  { label: "3:4", value: 3 / 4 },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "16:9", value: 16 / 9 },
];

/**
 * Models confirmed by a live call to reject anything outside RESTRICTED_RATIOS.
 * Keep this to models actually tested - a wrong entry here blocks valid work.
 */
const RESTRICTED_RATIO_MODELS = new Set(["z-image"]);

/** 1024x1792 sits 1.6% off exact 9:16 and is accepted, so allow ~6%. */
const RATIO_TOLERANCE = 0.06;

/** Bounds the relay's own web client enforces before calling the same API. */
const MAX_LONG_EDGE = 3840;
const MIN_PIXELS = 655_360;
const MAX_PIXELS = 8_294_400;
const MAX_RATIO = 3;

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
  /** Warnings worth surfacing but not worth blocking on. */
  warnings: string[];
  error?: string;
}

function nearestRatio(ratio: number) {
  let best = RESTRICTED_RATIOS[0];
  let bestErr = Infinity;
  for (const cand of RESTRICTED_RATIOS) {
    const err = Math.abs(ratio - cand.value) / cand.value;
    if (err < bestErr) {
      bestErr = err;
      best = cand;
    }
  }
  return { best, err: bestErr };
}

export function validateSize(size: string, model: string): SizeCheck {
  const warnings: string[] = [];
  if (size === "auto") return { ok: true, warnings };

  const m = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!m) {
    return { ok: false, warnings, error: `size must be "WxH" (e.g. 1024x1024) or "auto", got ${JSON.stringify(size)}.` };
  }
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (w <= 0 || h <= 0) return { ok: false, warnings, error: `size must have positive dimensions, got ${size}.` };

  const long = Math.max(w, h);
  const ratio = Math.max(w / h, h / w);
  const pixels = w * h;

  if (ratio > MAX_RATIO) {
    return { ok: false, warnings, error: `size ${size} is ${ratio.toFixed(1)}:1; the provider caps aspect ratio at ${MAX_RATIO}:1.` };
  }
  if (long > MAX_LONG_EDGE) {
    warnings.push(`long edge ${long}px exceeds the usual ${MAX_LONG_EDGE}px ceiling; the provider may downscale or reject it.`);
  }
  if (pixels < MIN_PIXELS) {
    warnings.push(`${size} is only ${pixels} pixels, below the usual ${MIN_PIXELS} minimum.`);
  }
  if (pixels > MAX_PIXELS) {
    warnings.push(`${size} is ${pixels} pixels, above the usual ${MAX_PIXELS} maximum.`);
  }
  if (w % 16 !== 0 || h % 16 !== 0) {
    warnings.push(`${size} is not a multiple of 16; the provider rounds to a 16px grid, so the output may differ.`);
  }

  if (RESTRICTED_RATIO_MODELS.has(model)) {
    const { err } = nearestRatio(w / h);
    if (err > RATIO_TOLERANCE) {
      return {
        ok: false,
        warnings,
        error:
          `${model} only accepts aspect ratios ${RESTRICTED_RATIOS.map((r) => r.label).join(", ")} (or "auto"), ` +
          `and ${size} is ${(w / h).toFixed(3)}. Try one of: ${SIZE_EXAMPLES.join(", ")}. ` +
          `Other models are less restrictive - gpt-image-2 accepts 3:2 and 21:9, for instance.`,
      };
    }
  }
  return { ok: true, warnings };
}

/**
 * The API echoes back whatever quality string it is given (it accepted "ultra"
 * in testing and reported quality_used "ultra"), so validation has to happen
 * here or a typo silently changes what the request does and costs.
 */
export function validateQuality(quality: string): string | null {
  return (QUALITY_VALUES as readonly string[]).includes(quality)
    ? null
    : `quality must be one of ${QUALITY_VALUES.join(", ")}, got ${JSON.stringify(quality)}. ` +
        `The upstream API does NOT validate this field and will accept a typo at an unknown tier.`;
}

/** Rewrites the upstream ratio complaint into something the caller can act on. */
export function explainSizeError(message: string, size: string, model: string): string | null {
  const m = /expected one of ([^}]*)/.exec(message);
  if (!m) return null;
  const allowed = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).filter((x) => /^\d+:\d+$|^auto$/.test(x));
  if (!allowed.length) return null;
  return (
    `${model} rejected size ${size}: it only accepts aspect ratios ${allowed.join(", ")}. ` +
    `Pick a WxH matching one of those, e.g. ${SIZE_EXAMPLES.join(", ")}.`
  );
}
