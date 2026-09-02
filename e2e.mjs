import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Resolved from this file so the harness runs from any checkout location.
const PROJ = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.PROIMAGE_SAVE_DIR?.trim() || join(tmpdir(), "pro-image-e2e");

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [`${PROJ}/dist/index.js`],
  env: {
    ...process.env,
    PROIMAGE_API_KEY: process.env.PROIMAGE_API_KEY,
    PROIMAGE_BASE_URL: "https://us.prorisehub.com",
    PROIMAGE_SAVE_DIR: OUT,
    PROIMAGE_DEFAULT_MODEL: "z-image",
  },
  stderr: "inherit",
});

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("=== TOOLS ===");
for (const t of tools.tools) {
  const req = t.inputSchema?.required ?? [];
  console.log(`  ${t.name}  required=[${req.join(",")}]`);
}

async function call(name, args, label) {
  console.log(`\n=== ${label ?? name} ===`);
  const t0 = Date.now();
  try {
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 300000,
      maxTotalTimeout: 600000,
      resetTimeoutOnProgress: true,
      onprogress: (p) => console.log(`    ...progress ${p.progress}${p.total ? "/" + p.total : ""}${p.message ? " " + p.message : ""}`),
    });
    const body = r.content.map((c) => c.text).join("\n");
    console.log(`[${r.isError ? "ERROR" : "OK"}] ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(body.length > 1400 ? body.slice(0, 1400) + "\n...(truncated)" : body);
    return { r, body };
  } catch (e) {
    console.log(`[THREW] ${e.message}`);
    return { r: null, body: "" };
  }
}

const only = process.argv[2];
const want = (n) => !only || only.split(",").includes(n);

if (want("info")) await call("server_info", {});
if (want("models")) await call("list_models", { filter: "flux" });

// --- Local validation: these must fail WITHOUT spending money ---
if (want("valid")) {
  await call("image_generate", { prompt: "x", quality: "low", size: "1536x1024" }, "REJECT 3:2 size");
  await call("image_generate", { prompt: "x", quality: "ultra", size: "1024x1024" }, "REJECT bad quality");
  await call("image_edit", { image_path: "Z:/nope.png", prompt: "x", quality: "low", size: "1024x1024" }, "REJECT missing file");
}

// --- Real billed calls ---
let genPath;
if (want("gen")) {
  const { body } = await call(
    "image_generate",
    { prompt: "a single red maple leaf on white background, minimal", quality: "low", size: "1024x1024", model: "z-image" },
    "GENERATE (billed)",
  );
  genPath = /saved: (.+?) \(/.exec(body)?.[1];
  console.log("captured path:", genPath);
}

if (want("upscale")) {
  await call(
    "image_generate",
    { prompt: "a grey square", quality: "low", size: "4096x4096", model: "z-image" },
    "UPSCALE WARNING check (billed)",
  );
}

if (want("edit") && genPath) {
  await call("image_edit", { image_path: genPath, prompt: "make the leaf golden yellow", quality: "low", size: "1024x1024", model: "nano-banana" }, "EDIT (billed)");
}

if (want("multiref") && genPath) {
  await call(
    "image_multi_reference",
    { image_paths: [genPath, genPath], prompt: "place both leaves side by side", quality: "low", size: "1024x1024", model: "byte-plus-seedream-5-lite" },
    "MULTI-REF (billed)",
  );
}

if (want("batch")) {
  await call(
    "image_batch_generate",
    { prompts: ["a blue circle", "a green triangle"], quality: "low", size: "1024x1024", model: "z-image", concurrency: 2 },
    "BATCH (billed)",
  );
}

await client.close();
console.log("\n=== done ===");
process.exit(0);
