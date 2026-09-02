# pro-image-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP: stdio](https://img.shields.io/badge/MCP-stdio-orange.svg)](https://modelcontextprotocol.io)
[![npm: pending](https://img.shields.io/badge/npm-pending%20publish-lightgrey.svg)](https://github.com/DawnJson/Pro-Image-Mcp)

Model Context Protocol (MCP) stdio server wrapping OpenAI-compatible image relay stations (New API / one-api family) into structured image generation and editing tools.

English | [简体中文](./README.zh-CN.md)

---

## Overview

`pro-image-mcp` exposes image generation endpoints to AI coding assistants such as Claude Code, Cursor, and Codex. It enforces three core invariants:

- **Explicit cost parameters**: `quality` and `size` are strictly required on all generation and editing tools to prevent silent billing defaults.
- **Measured, not predicted, costs**: spend is calculated by sampling the `/v1/dashboard/billing/usage` endpoint before and after each billed call, reporting the exact dollar delta.
- **Surfaced silent failures**: the server detects and warns on ignored reference images (`:text2image` response pipelines), rendered-vs-target size mismatches, and parameters dropped due to model-family incompatibilities.

Image responses always use `response_format: "url"`. Downloaded files are saved locally to disk, returning absolute file paths so image bytes never pollute LLM context windows.

## Requirements

- Node.js >= 18.0.0
- An API key for an OpenAI-compatible image relay station (such as New API / one-api deployments; default base URL `https://newapi.prorisehub.com`)

## Quickstart

### 1. Install from Source

> Note: The npm package is currently pending publication. Install from source via `git clone`. Once published, direct execution via `npx -y pro-image-mcp` will be supported.

```bash
git clone https://github.com/DawnJson/Pro-Image-Mcp.git
cd Pro-Image-Mcp
npm install
npm run build
```

### 2. Configure Your MCP Client

Add `pro-image` to your client's MCP config — Claude Code: project `.mcp.json` (or `claude mcp add`); Claude Desktop: `claude_desktop_config.json`; Cursor: `~/.cursor/mcp.json`. Point `args` at the absolute path of `dist/index.js`.

```json
{
  "mcpServers": {
    "pro-image": {
      "command": "node",
      "args": ["/path/to/Pro-Image-Mcp/dist/index.js"],
      "env": {
        "PROIMAGE_API_KEY": "sk-your-relay-api-key",
        "PROIMAGE_BASE_URL": "https://newapi.prorisehub.com",
        "PROIMAGE_SAVE_DIR": "/path/to/output/images",
        "PROIMAGE_DEFAULT_MODEL": "gpt-image-2"
      }
    }
  }
}
```

*On Windows, path formats like `C:/path/to/Pro-Image-Mcp/dist/index.js` and `C:/images-out` may be used.*

### 3. Usage Example

Prompt your MCP-enabled agent:
> *"Generate a minimalist red maple leaf on a clean white background using gpt-image-2 with high quality and 1024x1024 size."*

## Configuration

The server is configured via environment variables passed into the MCP process:

| Variable | Default | Required | Description |
|---|---|---|---|
| `PROIMAGE_API_KEY` | *(none)* | Yes | API key for the image relay station. |
| `PROIMAGE_BASE_URL` | `https://newapi.prorisehub.com` | No | Relay base URL. Must be `https`; plain `http` is rejected unless the host is `localhost`/`127.0.0.1`, because the API key is sent as a bearer token on every request. Trailing slashes are stripped. |
| `PROIMAGE_SAVE_DIR` | `~/Pictures/pro-image-mcp` | No | Local filesystem directory where downloaded images are saved. |
| `PROIMAGE_SAVE_DIR_ROOT` | Effective `PROIMAGE_SAVE_DIR` | No | Output sandbox root. Every `save_dir` argument must resolve inside this root (relative paths resolve against it; symlinks resolved). Escapes are rejected locally before any billed call. Set wider if writing outside the default save directory is required. |
| `PROIMAGE_INPUT_ROOT` | *(unset)* | No | Optional input sandbox root. When set, every `image_path` / `image_paths` reference must resolve inside this root (symlinks resolved). Defense in depth on top of magic-byte validation. |
| `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS` | Derived from `PROIMAGE_BASE_URL` | No | Comma-separated list of allowed download hosts. Defaults to the base URL host and subdomains of its parent domain (e.g., `newapi.prorisehub.com` and `*.prorisehub.com`). Image URLs from the relay outside this list are refused. Downloads must use `https` (`http` permitted only for `localhost`/`127.0.0.1`). |
| `PROIMAGE_DEFAULT_MODEL` | `gpt-image-2` | No | Default model used when the `model` parameter is omitted. |
| `PROIMAGE_TIMEOUT_MS` | `300000` | No | Single HTTP request timeout in milliseconds (5 minutes). |
| `PROIMAGE_CONCURRENCY` | `3` | No | Default concurrency limit for `image_batch_generate`. |

## Tools Reference

| Tool | Purpose | Key Arguments |
|---|---|---|
| `image_generate` | Text-to-image generation via `/v1/images/generations`. | `prompt`, `quality`*, `size`*, `model`, `n`, `save_dir`, extra args |
| `image_edit` | Image-to-image single-reference edit via `/v1/images/edits`. | `image_path`, `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_multi_reference` | Blend 2–10 reference images via `/v1/images/edits`. | `image_paths` (2–10), `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_batch_generate` | Batch generation across multiple prompts with bounded concurrency. | `prompts` (1–20), `quality`*, `size`*, `model`, `concurrency`, `save_dir` |
| `list_models` | List available models, estimated list prices, and reference-image support. | `filter`, `size`, `quality`, `supports` (`any` \| `image_to_image` \| `text_to_image_only`) |
| `server_info` | Query server settings, quota limit, usage spend, and relay constraints. | *(no arguments)* |

*\* `quality` (`low` \| `medium` \| `high`) and `size` (`WxH` or `auto`) are strictly required on all four billed tools.*

Before any billed upstream call is made, inputs are validated locally:
- `save_dir` is strictly confined to the sandbox root (`PROIMAGE_SAVE_DIR_ROOT`).
- Reference images in `image_edit` and `image_multi_reference` are checked for valid magic bytes (PNG, JPEG, WebP, GIF) and a 25 MB per-file limit. Non-image files are refused locally so LLM-controlled paths cannot exfiltrate arbitrary files.

### Output Audit Block Format

Every image operation returns a structured audit block indicating execution details, actual measured costs, rendered resolutions, and warnings:

```text
model=gpt-image-2  quality=low  size=1024x1024
cost=$0.02333  upstream_credits=5  quality_used=low
rendered 1024x1024
saved: /path/to/output/images/20260902-093806-771-gpt-image-2.png (1024x1024, 958KB)
```

If a model does not accept `quality`, the audit block marks it as `quality=high (not sent)` and appends an informational note explaining that the parameter was omitted on the wire.

## Model and Capability Notes

- **Aspect ratio validation**: Permitted aspect ratios are enforced per-model rather than via a global whitelist. Confirmed restricted models (such as `z-image`, which accepts only `1:1`, `3:4`, `4:3`, `9:16`, `16:9`, and `auto`) are validated locally and rejected immediately with 0 ms network delay and zero cost. Ratios exceeding 3:1 are blocked universally. Other models pass through to upstream evaluation.
- **Model-family parameter filtering**: Upstream APIs silently ignore unknown fields while returning HTTP 200. To prevent misleading configurations, parameters are filtered by model family:

| Family | Fields sent on the wire (source: `src/params.ts`) |
|---|---|
| `gpt-image` | `size`, `quality`, `background`, `output_format`, `output_compression`, `moderation`, `input_fidelity` |
| `gpt4o-image` | `size`, `quality`, `background` |
| `seedream` | `size`, `quality`, `seed`, `negative_prompt`, `watermark` |
| `qwen` | `size`, `seed`, `negative_prompt`, `watermark`, `prompt_extend` |
| `flux` | `size`, `seed`, `output_format` |
| `imagen` | `size`, `seed` |
| `hunyuan-image` | `size`, `quality` |
| `dalle` | `size`, `style` |
| `nano-banana`, `sora-image` | `size` |
| `z-image` | `negative_prompt` |
| `grok-imagine` | `resolution` |
| `agnes-image` | none |
| unrecognised model | permissive: `size`, `quality`, `seed`, `negative_prompt`, `watermark`, `background`, `output_format`, `input_fidelity` |

- **Silently ignored references**: Upstream endpoints may return HTTP 200 and accept image uploads while running a pure text-to-image generation. The server inspects the returned pipeline model suffix: `:image2image` confirms reference usage, while `:text2image` signals that references were discarded. On a tested channel key, only 4 models (`gpt-image-2`, `nano-banana`, `qwen-image-2`, `wan2-7-image`) actively used reference images, while 16 other reachable models silently ignored them.
- **Capability probing script**: Re-test your active key and channel group capabilities at any time. It imports the compiled server modules, so run `npm run build` first:
  ```bash
  node scripts/probe-capabilities.mjs              # Dry run: estimates total probing cost
  node scripts/probe-capabilities.mjs --confirm    # Live test: runs edits and outputs verified mappings
  ```

## Cost Accounting

- **Measured vs. predicted**: Prices derived from `/api/pricing` are indicative list prices used for comparing models. Actual billing is measured directly by polling `/v1/dashboard/billing/usage` before and after each operation.
- **Account-wide usage caveat**: The billing endpoint measures account-wide usage. Concurrent operations across other clients sharing the same API key will be reflected in the measured delta. Batch generation measures total spend across the entire batch.
- **Quota limit vs. balance**: In `/v1/dashboard/billing/subscription`, `hard_limit_usd` is a fixed quota ceiling, not a real-time balance. The `server_info` tool computes remaining balance by subtracting total usage from `hard_limit_usd`.

## Troubleshooting

- **Missing API key (`PROIMAGE_API_KEY is not set`)**: Ensure `PROIMAGE_API_KEY` is present in the `env` block of your MCP client configuration.
- **Authentication error (`AUTH_UNAUTHORIZED` / HTTP 401)**: Verify that the API key is active, correctly typed, and authorized for the target relay station.
- **Client timeout (60-second limit)**: High-resolution generation and multi-reference operations take 15–60 seconds. The server emits `notifications/progress` heartbeats every 5 seconds. If your client does not extend timeouts on progress, increase its request timeout (e.g., set `MCP_TIMEOUT=300000` for Claude Code).
- **Size rejection error**: If an upstream model rejects an aspect ratio, the server formats the error into an actionable message specifying acceptable ratios (e.g., `expected one of "1:1"|"3:4"|"4:3"|"9:16"|"16:9"|"auto"`).
- **Reference-ignored warning**: If `image_edit` or `image_multi_reference` returns a warning indicating `:text2image`, switch to a model verified for image-to-image input (use `list_models` with `supports="image_to_image"`).
- **Save directory outside root**: The requested `save_dir` escapes `PROIMAGE_SAVE_DIR_ROOT`. Set `save_dir` within the permitted sandbox, or widen `PROIMAGE_SAVE_DIR_ROOT` in the client environment.
- **Invalid reference image**: The file specified in `image_path` / `image_paths` is not a valid image format (PNG, JPEG, WebP, GIF) or exceeds the 25 MB per-file size limit. Non-image files are refused locally before uploading.
- **Untrusted download host**: The relay returned an image download URL with a host not allowed by `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS`. Add the relay's storage domain to `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS` or verify that the relay is returning valid URLs.

## Development

Run development scripts directly via npm:

```bash
npm run build   # Compile TypeScript (tsc) to dist/
npm run dev     # Watch mode (tsc --watch)
npm run check   # Typecheck without emitting code (tsc --noEmit)
npm run smoke   # Zero-cost smoke validation (node e2e.mjs valid)
npm start       # Run the compiled server via node dist/index.js
```

### End-to-End Test Suite (`e2e.mjs`)

The repository includes `e2e.mjs` for testing against an active MCP server:

```bash
# Free tests (local validation and inspection)
node e2e.mjs valid          # Rejection tests: invalid ratio, invalid quality, missing file, non-image input, save_dir escape and traversal
node e2e.mjs info,models    # server_info and list_models calls

# Billed tests (incurs real upstream charges)
node e2e.mjs gen            # Single image generation
node e2e.mjs upscale        # High-resolution generation testing upscale detection
node e2e.mjs edit           # Single-image edit (requires previous gen output)
node e2e.mjs multiref       # Multi-reference image blend
node e2e.mjs batch          # Concurrency batch generation
```

## Security

- **API key handling**: Never commit API keys or sensitive endpoints to version control. Keep `.env` files gitignored and pass keys strictly through the MCP client execution environment.
- **HTTPS-only transport**: `PROIMAGE_BASE_URL` and image download endpoints must use `https` (plain `http` is permitted only for `localhost`/`127.0.0.1`), as the API key is transmitted as a bearer token on every request.
- **Output sandbox**: Downloaded images are confined to `PROIMAGE_SAVE_DIR_ROOT`. User- or agent-supplied `save_dir` arguments cannot escape this directory (symlinks resolved).
- **Input validation & sandboxing**: Reference images supplied to `image_edit` / `image_multi_reference` are verified via magic bytes (PNG, JPEG, WebP, GIF) and capped at 25 MB per file before upload, preventing arbitrary local files from being uploaded. When `PROIMAGE_INPUT_ROOT` is set, input paths are strictly confined to that root.
- **Download allowlist**: Download URLs returned by the relay are validated against `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS` before fetching, preventing SSRF or unwanted outbound requests.

## Disclaimer

This project is an independent open-source tool and is not affiliated with, endorsed by, or sponsored by any relay operator or upstream service provider. Model availability, pricing rules, and capability support reflect empirical observations from specific channel groups and may vary across different accounts, tiers, or endpoints.

## License

Distributed under the [MIT License](LICENSE). Bug reports and feature suggestions can be submitted via [GitHub Issues](https://github.com/DawnJson/Pro-Image-Mcp/issues).
