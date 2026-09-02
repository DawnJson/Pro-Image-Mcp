#!/usr/bin/env node
/**
 * Determines, by live call, which models actually accept image input.
 *
 * The relay publishes no capability flag, so `list_models` infers image-to-image
 * support from each vendor's description. This script replaces that guess with
 * ground truth: it sends one real /v1/images/edits request per model and reports
 * which succeed. It BILLS one image per model tested.
 *
 *   node scripts/probe-capabilities.mjs                 # dry run: cost estimate only
 *   node scripts/probe-capabilities.mjs --confirm       # actually spend
 *   node scripts/probe-capabilities.mjs --confirm --only nano-banana,z-image
 *
 * Paste the emitted block into MEASURED_IMAGE_TO_IMAGE in src/capabilities.ts.
 */
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY = process.env.PROIMAGE_API_KEY?.trim();
const BASE = (process.env.PROIMAGE_BASE_URL?.trim() || "https://newapi.prorisehub.com").replace(/\/+$/, "");
if (!KEY) {
  console.error("PROIMAGE_API_KEY is not set.");
  process.exit(1);
}

const args = process.argv.slice(2);
const confirmed = args.includes("--confirm");
const onlyArg = args[args.indexOf("--only") + 1];
const only = args.includes("--only") && onlyArg ? onlyArg.split(",").map((s) => s.trim()) : null;

// The cheapest tier keeps the probe as inexpensive as possible.
const PROBE_SIZE = "1024x1024";
const PROBE_QUALITY = "low";

async function api(path, init) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${KEY}`, ...init?.headers } });
  const body = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

function longEdge(size) {
  const m = /^(\d+)x(\d+)$/.exec(size);
  return m ? Math.max(+m[1], +m[2]) : null;
}

function estimate(entry, size, quality) {
  if (!entry || entry.quota_type !== 1 || typeof entry.model_price !== "number") return null;
  let usd = entry.model_price;
  for (const r of entry.sku_ratios ?? []) {
    if (r.enabled === false || !r.models?.includes(entry.model_name)) continue;
    if (r.source === "size" && r.tiers?.length) {
      const edge = longEdge(size);
      const tier = r.tiers.find((t) => t.up_to > 0 && edge <= t.up_to) ?? r.tiers.at(-1);
      if (typeof tier?.ratio === "number") usd *= tier.ratio;
    } else if (r.source === "quality" && typeof r.enum?.[quality] === "number") {
      usd *= r.enum[quality];
    }
  }
  return usd;
}

const [models, pricing] = await Promise.all([
  api("/v1/models", { method: "GET" }).then((j) => j.data ?? []),
  api("/api/pricing", { method: "GET" })
    .then((j) => j.data ?? [])
    .catch(() => []),
]);
const byName = new Map(pricing.map((p) => [p.model_name, p]));
const targets = models.map((m) => m.id).filter((id) => !only || only.includes(id));

const total = targets.reduce((sum, id) => sum + (estimate(byName.get(id), PROBE_SIZE, PROBE_QUALITY) ?? 0), 0);
console.log(`Probing ${targets.length} model(s) at size=${PROBE_SIZE} quality=${PROBE_QUALITY}.`);
console.log(`Estimated cost: $${total.toFixed(4)} before the key's channel-group ratio.`);
console.log(`(A probe that FAILS is usually not billed, so this is an upper bound.)\n`);

if (!confirmed) {
  console.log("Dry run. Re-run with --confirm to actually send the requests.");
  process.exit(0);
}

// One shared reference image, generated once with the cheapest model available.
const cheapest = targets
  .map((id) => ({ id, usd: estimate(byName.get(id), PROBE_SIZE, PROBE_QUALITY) ?? Infinity }))
  .sort((a, b) => a.usd - b.usd)[0];
console.log(`Creating one reference image with ${cheapest.id}...`);
const seed = await api("/v1/images/generations", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: cheapest.id,
    prompt: "a plain solid grey square, no detail",
    size: PROBE_SIZE,
    quality: PROBE_QUALITY,
    response_format: "url",
  }),
});
// The relay returns URLs with a leading space.
const seedUrl = seed.data?.[0]?.url?.trim();
if (!seedUrl) {
  console.error("Could not create a reference image; aborting.");
  process.exit(1);
}
const refBytes = Buffer.from(await (await fetch(seedUrl)).arrayBuffer());
const refPath = join(tmpdir(), "pro-image-probe-ref.png");
await writeFile(refPath, refBytes);
console.log(`Reference saved to ${refPath} (${(refBytes.length / 1024).toFixed(0)}KB)\n`);

const results = [];
for (const id of targets) {
  process.stdout.write(`${id.padEnd(32)} `);
  const form = new FormData();
  form.append("model", id);
  form.append("prompt", "change the square to solid blue");
  form.append("size", PROBE_SIZE);
  form.append("quality", PROBE_QUALITY);
  form.append("n", "1");
  form.append("image", new Blob([new Uint8Array(refBytes)], { type: "image/png" }), "ref.png");

  const startedAt = Date.now();
  try {
    const out = await api("/v1/images/edits", { method: "POST", body: form });
    // The response `model` carries the pipeline that actually ran:
    // "nano-banana:image2image" used the reference, "z-image:text2image" did not.
    // references_uploaded only proves bytes arrived and is 1 in both cases.
    const ran = out.model ?? "";
    const ok = ran.includes(":image2image");
    results.push({ id, ok, note: ran, credits: out._meta?.credits_charged });
    console.log(`${ok ? "USES REFS" : "IGNORES REFS"}  ran=${ran}  ${((Date.now() - startedAt) / 1000).toFixed(0)}s`);
  } catch (e) {
    results.push({ id, ok: false, note: String(e.message).slice(0, 120) });
    console.log(`NO  ${String(e.message).slice(0, 90)}`);
  }
}

console.log("\n--- paste into MEASURED_IMAGE_TO_IMAGE in src/capabilities.ts ---\n");
console.log("const MEASURED_IMAGE_TO_IMAGE: Record<string, boolean> = {");
for (const r of results.sort((a, b) => a.id.localeCompare(b.id))) {
  console.log(`  ${JSON.stringify(r.id)}: ${r.ok},`);
}
console.log("};");
