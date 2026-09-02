import type { PricingEntry, SkuRule } from "./client.js";

/**
 * The relay bills image models per call (`quota_type` 1) at `model_price`,
 * then multiplies by any SKU rules that list the model, then by the ratio of
 * the channel group the API key belongs to.
 *
 * Two SKU rules exist in practice, both driven by request parameters:
 *   size    - tiered on the long edge: <=1024 x0.70, <=2048 x0.85, <=3072 x0.95, else x1.00
 *   quality - an enum (low 0.7 / medium 0.85 / high 1.0 / auto 1.0) that, on this
 *             relay, is attached only to gpt-image-1-5 and gpt-image-2
 *
 * This is why quality changed nothing on z-image's charge in testing: z-image
 * carries neither rule and is billed flat.
 *
 * IMPORTANT: this computation is a LIST price, not the bill. Measured against
 * the account usage endpoint, real charges came in at almost exactly half the
 * computed figure across three models with different rule shapes (z-image flat,
 * nano-banana size-tiered, gpt-image-2 size+quality tiered), and the published
 * group ratios do not account for the difference. Use it to compare models;
 * use RelayClient.usageUsd() deltas for what something actually cost.
 *
 * The channel group is a SEPARATE axis and is NOT the `quality` parameter.
 * Groups select which upstream source fulfils the request; they are fixed by
 * the key and cannot be set per request. The `quality` parameter selects the
 * render quality within whichever source serves the call. A group's ratio
 * therefore cannot be computed from `quality`, and this estimate deliberately
 * stops before it.
 */
export interface PriceEstimate {
  /** Price before the key's channel-group ratio, in USD. */
  usd: number | null;
  /** Human-readable derivation, e.g. "$0.1 base x 0.70 (1K) x 0.85 (quality medium)". */
  breakdown: string;
}

function longEdge(size: string): number | null {
  const m = /^(\d+)x(\d+)$/.exec(size.trim());
  if (!m) return null;
  return Math.max(Number(m[1]), Number(m[2]));
}

function rulesFor(entry: PricingEntry): SkuRule[] {
  return (entry.sku_ratios ?? []).filter(
    (r) => r.enabled !== false && Array.isArray(r.models) && r.models.includes(entry.model_name),
  );
}

/** True when the model's charge varies with size or quality at all. */
export function hasSkuRules(entry: PricingEntry | undefined): boolean {
  return !!entry && rulesFor(entry).length > 0;
}

export function estimatePrice(
  entry: PricingEntry | undefined,
  size: string,
  quality: string,
): PriceEstimate {
  if (!entry || entry.quota_type !== 1 || typeof entry.model_price !== "number") {
    return { usd: null, breakdown: "per-image price unavailable for this model" };
  }

  let usd = entry.model_price;
  const parts = [`$${entry.model_price} base`];

  for (const rule of rulesFor(entry)) {
    if (rule.source === "size" && rule.tiers?.length) {
      const edge = longEdge(size);
      if (edge === null) {
        parts.push("size tier unknown (auto)");
        continue;
      }
      // `up_to: 0` marks the open-ended top tier.
      const tier = rule.tiers.find((t) => t.up_to > 0 && edge <= t.up_to) ?? rule.tiers[rule.tiers.length - 1];
      if (tier && typeof tier.ratio === "number") {
        usd *= tier.ratio;
        parts.push(`x${tier.ratio} (${tier.label ?? "size"})`);
      }
    } else if (rule.source === "quality" && rule.enum) {
      const ratio = rule.enum[quality];
      if (typeof ratio === "number") {
        usd *= ratio;
        parts.push(`x${ratio} (quality ${quality})`);
      }
    }
  }

  if (parts.length === 1) parts.push("flat (no size/quality tiers)");
  return { usd, breakdown: parts.join(" ") };
}

export function formatUsd(usd: number | null): string {
  return usd === null ? "?" : `$${usd.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
}
