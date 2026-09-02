# pro-image-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP: stdio](https://img.shields.io/badge/MCP-stdio-orange.svg)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/pro-image-mcp.svg)](https://www.npmjs.com/package/pro-image-mcp)

Model Context Protocol (MCP) stdio server wrapping OpenAI-compatible image relay stations (New API / one-api family) into structured image generation and editing tools.

[简体中文](./README.md) | English

---

## What It Is

`pro-image-mcp` connects AI coding assistants (Claude Code, Cursor, Codex) to OpenAI-compatible image relay endpoints over stdio. It guarantees:
- **Explicit quality and size**: Required on all billed tools to prevent silent tier jumps. When unstated, tool descriptions instruct the client model to pick (cheapest tier, implied aspect ratio) rather than interrogate the user.
- **Measured costs**: Spend is calculated from `/v1/dashboard/billing/usage` deltas after each call, never guessed. List prices from `list_models` are for comparison only.
- **Paths, not bytes**: Downloaded images are saved to disk; only local absolute paths return to context so image bytes never pollute LLM windows.

## Tools

| Tool | Purpose | Key Arguments |
|---|---|---|
| `image_generate` | Text-to-image generation via `/v1/images/generations`. | `prompt`, `quality`*, `size`*, `model`, `n`, `save_dir`, extra args |
| `image_edit` | Single-reference edit via `/v1/images/edits`. | `image_path`, `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_multi_reference` | Blend 2–10 reference images via `/v1/images/edits`. | `image_paths`, `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_batch_generate` | Batch generation across 1–20 prompts. | `prompts`, `quality`*, `size`*, `model`, `concurrency`, `save_dir` |
| `list_models` | List models, list prices, and reference-image support. | `filter`, `size`, `quality`, `supports` |
| `server_info` | Query server settings, quota, usage, and relay constraints. | *(none)* |

*\* `quality` and `size` are strictly required on all four billed tools because both affect the price.*

## Quickstart

```bash
npx -y pro-image-mcp             # run straight from npm
npm install -g pro-image-mcp     # or install globally
```

To pin an exact version, query `npm view pro-image-mcp version` and specify `pro-image-mcp@<version>`.

```json
{
  "mcpServers": {
    "pro-image": {
      "command": "npx",
      "args": ["-y", "pro-image-mcp"],
      "env": {
        "PROIMAGE_API_KEY": "sk-[REDACTED]",
        "PROIMAGE_BASE_URL": "https://newapi.prorisehub.com",
        "PROIMAGE_SAVE_DIR": "/path/to/output/images",
        "PROIMAGE_DEFAULT_MODEL": "gpt-image-2"
      }
    }
  }
}
```

On Windows, clients that spawn argv directly without a shell (e.g. Codex) fail with `ENOENT` for bare `pro-image-mcp` or `npx`. Use `"command": "node"` with the absolute `dist/index.js` path (`npm root -g` prints the prefix), or `"command": "cmd", "args": ["/c", "pro-image-mcp"]`.

Example prompt:
> *"Generate a minimalist red maple leaf on a clean white background using gpt-image-2 with high quality and 1024x1024 size."*

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROIMAGE_API_KEY` | *(none)* | **Required**. Relay API key. Missing key exits immediately. |
| `PROIMAGE_BASE_URL` | `https://newapi.prorisehub.com` | Relay base URL. Must be `https` (`http` only for localhost). |
| `PROIMAGE_SAVE_DIR` | `~/Pictures/pro-image-mcp` | Directory where downloaded images are saved. |
| `PROIMAGE_DEFAULT_MODEL` | `gpt-image-2` | Fallback model when `model` argument is omitted. |
| `PROIMAGE_TIMEOUT_MS` | `300000` | Single HTTP request timeout in ms (5 minutes). |
| `PROIMAGE_CONCURRENCY` | `3` | Default concurrency limit for `image_batch_generate`. |
| `PROIMAGE_SAVE_DIR_ROOT` | Effective save dir | Output sandbox root; every `save_dir` must resolve inside it. |
| `PROIMAGE_INPUT_ROOT` | *(unset)* | Optional input sandbox root for reference images. |
| `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS` | Derived from base URL | Allowed download hosts (defaults to base domain and subdomains). |

## What You Get Back

Every image operation returns a structured audit block and the saved local file path:

```text
model=gpt-image-2  quality=low  size=1024x1024
cost=$0.02333  upstream_credits=5  quality_used=low
rendered 1024x1024
saved: /path/to/output/images/20260902-093806-771-gpt-image-2.png (1024x1024, 958KB)
```

`cost` is the real billing delta measured from `/v1/dashboard/billing/usage`. `rendered` is the size the model actually generated as reported upstream; when it falls below the size you paid for, the block warns that the difference is upscaling rather than detail. When a model does not accept `quality`, the audit block logs `quality=<val> (not sent)` and omits it on the wire.

## Choosing a Model

The default model is `gpt-image-2`. Use `list_models` to view available models, list prices, and reference-image support. Some models accept reference images on `/v1/images/edits`, ignore them, and still bill; specify `supports="image_to_image"` to filter for measured support. To re-measure for your own key, run `npm run build` first, then `node scripts/probe-capabilities.mjs` for a cost estimate; adding `--confirm` issues the billed calls.

## Troubleshooting

- **Missing API key**: If `PROIMAGE_API_KEY` is not set in the client `env` block, the server exits immediately with an explanatory error.
- **401 Unauthorized**: Verify that the API key is active, valid, and authorized for the target relay.
- **Client timeout**: Generation takes 15–60s with 5s progress heartbeats; raise client timeout if needed (e.g. `MCP_TIMEOUT=300000` for Claude Code).
- **Rejected size or ratio**: Model rejected the requested aspect ratio; check the error message for supported ratios or use `auto`.
- **Reference image ignored**: If the audit warns of `:text2image`, the model ignored the reference; switch to a model verified via `list_models(supports="image_to_image")`.

## Safety and Limits

- **HTTPS transport**: `PROIMAGE_BASE_URL` and image downloads enforce `https` (`http` only for localhost) to protect bearer tokens.
- **Output sandbox**: `save_dir` is confined to `PROIMAGE_SAVE_DIR_ROOT` (symlinks resolved); escapes are rejected locally before billed calls.
- **Input validation**: Reference images are verified via magic bytes (PNG, JPEG, WebP, GIF) and capped at 25 MB before upload.
- **Download allowlist**: Image download URLs are restricted to `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS` to prevent SSRF.

## Development

```bash
npm run build   # Compile TypeScript (tsc) to dist/
npm run dev     # Watch mode (tsc --watch)
npm run check   # Typecheck without emitting code (tsc --noEmit)
npm run smoke   # Zero-cost smoke validation (node e2e.mjs valid)
npm start       # Run the compiled server via node dist/index.js
```

Run `node e2e.mjs valid` or `info,models` for free local validation; `gen`, `edit`, `multiref`, and `batch` incur real upstream charges.

## Disclaimer

`pro-image-mcp` is an independent open-source tool not affiliated with or endorsed by any relay operator. Model availability, pricing, and observed capabilities reflect empirical snapshots that may vary across accounts, tiers, and channel groups.

## License

Distributed under the [MIT License](LICENSE). Bug reports and feature suggestions can be submitted via [GitHub Issues](https://github.com/DawnJson/Pro-Image-Mcp/issues).
