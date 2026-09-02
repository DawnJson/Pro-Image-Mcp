# pro-image-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP: stdio](https://img.shields.io/badge/MCP-stdio-orange.svg)](https://modelcontextprotocol.io)
[![npm](https://img.shields.io/npm/v/pro-image-mcp.svg)](https://www.npmjs.com/package/pro-image-mcp)

一个基于 Model Context Protocol (MCP) 的 stdio 服务器，将 OpenAI 兼容的图像中转站（New API / one-api 体系）封装为标准化的图像生成与编辑工具。

简体中文 | [English](./README.en.md)

---

## 这是什么

`pro-image-mcp` 是一个 MCP stdio 服务端，将 OpenAI 兼容的图像中转站接口封装为供 Claude Code、Cursor、Codex 等 AI 编程助手调用的图像工具。核心保证：
- **计费参数显式声明**：`quality` 与 `size` 均为必填项，未指定时由客户端模型按最低成本或提示词意图自动选择，不设静默默认值。
- **真实测算调用成本**：每次计费调用前后读取账单接口差值，报告实测扣费而非预估标价。
- **本地落盘返回路径**：图片存入本地磁盘并仅返回绝对路径，图片字节不挤占 LLM 上下文。

## 工具

| 工具 | 作用 | 核心参数 |
|---|---|---|
| `image_generate` | 文生图 (`/v1/images/generations`) | `prompt`, `quality`*, `size`*, `model`, `n`, `save_dir`, 扩展参数 |
| `image_edit` | 单图生图/编辑 (`/v1/images/edits`) | `image_path`, `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_multi_reference` | 2–10 张参考图融合生成 | `image_paths`, `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_batch_generate` | 批量文生图（受控并发） | `prompts` (1–20), `quality`*, `size`*, `model`, `concurrency`, `save_dir` |
| `list_models` | 查询可用模型、标价与参考图支持度 | `filter`, `size`, `quality`, `supports` (`any` \| `image_to_image` \| `text_to_image_only`) |
| `server_info` | 查询当前配置、余额、支出与已知约束 | *(无参数)* |

*\* `quality` (`low` \| `medium` \| `high`) 与 `size` (`WxH` 或 `auto`) 在四个计费生图工具中必填，未指定时模型应自主选择最廉价档位及匹配比例。*

## 快速开始

```bash
npm install -g pro-image-mcp     # 全局安装；或用 npx -y pro-image-mcp
```
锁定版本可写 `pro-image-mcp@<version>`，版本号用 `npm view pro-image-mcp version` 查询。在客户端配置（如 Claude Code 的 `.mcp.json`、Cursor 的 `mcp.json`）中添加：

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
Windows 下直接 spawn 进程的客户端（如 Codex）对裸 `pro-image-mcp` 或 `npx` 会报 `ENOENT`，请改用 `"command": "node"` 搭配 `dist/index.js` 绝对路径（通过 `npm root -g` 查询前缀），或用 `"command": "cmd"` 搭配 `"args": ["/c", "pro-image-mcp"]`。路径推荐使用正斜杠。

调用示例：向 AI 助手发送 *"使用 gpt-image-2 生成一张 1024x1024、quality 为 low 的白底极简红枫叶图标"*。

## 环境变量

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `PROIMAGE_API_KEY` | *(无)* | **必填**。中转站 API Key，未设置则服务报错退出。 |
| `PROIMAGE_BASE_URL` | `https://newapi.prorisehub.com` | 中转站接口地址。仅支持 `https`（`localhost`/`127.0.0.1` 允许 `http`）。 |
| `PROIMAGE_SAVE_DIR` | `~/Pictures/pro-image-mcp` | 图片本地保存目录。 |
| `PROIMAGE_DEFAULT_MODEL` | `gpt-image-2` | 省略 `model` 参数时的默认模型。 |
| `PROIMAGE_TIMEOUT_MS` | `300000` | HTTP 请求超时毫秒数（默认 5 分钟）。 |
| `PROIMAGE_CONCURRENCY` | `3` | `image_batch_generate` 的默认并发数。 |
| `PROIMAGE_SAVE_DIR_ROOT` | `PROIMAGE_SAVE_DIR` | 输出沙箱根目录，`save_dir` 必须解析在此根目录以内。 |
| `PROIMAGE_INPUT_ROOT` | *(未设置)* | 可选输入沙箱根目录，设置后参考图路径必须在此根目录以内。 |
| `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS` | 由基础地址推导 | 允许下载图片的受信任域名（逗号分隔），默认包含接口主机名及父域名子域。 |

## 返回内容

每次生成均返回结构化审计信息块，包含调用配置、实测扣费、实际渲染尺寸及保存路径：

```text
model=gpt-image-2  quality=low  size=1024x1024
cost=$0.02333  upstream_credits=5  quality_used=low
rendered 1024x1024
saved: /path/to/output/images/20260902-093806-771-gpt-image-2.png (1024x1024, 958KB)
```

若模型族不接受 `quality`，则标记为 `quality=... (not sent)` 并在本地过滤该参数；若实际渲染尺寸低于目标尺寸（上游插值放大），会输出警告。

## 选模型

默认模型为 `gpt-image-2`。调用 `list_models` 可查询当前密钥可访问的模型、参考标价（list price）及实测参考图支持度（`supports="image_to_image"`）。注意部分模型虽接受参考图并计费，但实际上游静默忽略并按文生图出图（响应标记 `:text2image`）。想针对自己的密钥重测：先 `npm run build`，再运行 `node scripts/probe-capabilities.mjs` 预估探测成本，加 `--confirm` 才会真实调用并计费。

## 遇到问题

- **缺少 API Key**：未设置 `PROIMAGE_API_KEY` 时服务端直接退出，请在客户端配置的 `env` 块中添加。
- **鉴权失败 (401)**：API Key 无效、已过期或无中转站对应权限。
- **客户端超时**：生成通常耗时 15–60 秒，服务端每 5 秒发送一次进度通知；若客户端超时断开，请调高客户端超时（如 Claude Code 设置 `MCP_TIMEOUT=300000`）。
- **尺寸/比例被拒**：模型不支持请求的宽高比（比例超过 3:1 全局拦截），请依错误提示选用该模型支持的比例。
- **参考图被忽略**：若收到 `:text2image` 警告，表明该模型在此渠道不生效图生图，请用 `list_models` 筛选 `supports="image_to_image"` 的模型。

## 安全与限制

- **传输安全**：仅允许 `https` 传输（非本机），防止 API Key 作为 Bearer token 明文泄露。
- **沙箱隔离**：输出强制限制在 `PROIMAGE_SAVE_DIR_ROOT` 内，杜绝路径穿越。
- **输入校验**：参考图必须通过文件魔数校验（PNG/JPEG/WebP/GIF）且单文件不超过 25 MB。
- **下载白名单**：图片下载链接仅限 `PROIMAGE_TRUSTED_DOWNLOAD_HOSTS` 允许的域名，防范 SSRF。

## 开发

```bash
npm run build   # 编译 TypeScript (tsc) 至 dist/
npm run dev     # 监听模式 (tsc --watch)
npm run check   # 类型检查 (tsc --noEmit)
npm run smoke   # 零成本冒烟验证 (node e2e.mjs valid)
npm start       # 启动编译产物 node dist/index.js
```

`e2e.mjs` 测试分为两阶段：`valid`、`info,models` 为只读免计费阶段；`gen`、`edit`、`batch` 等为真实扣费阶段。

## 免责声明

本项目为独立开源工具，与任何中转站运营商及上游模型供应商无关联。文档中记录的模型表现与计费规律为特定渠道下的实测快照，不同账户与渠道可能存在差异。

## 许可证

本项目遵循 [MIT 开源许可证](LICENSE)。如遇问题或建议欢迎提交 [GitHub Issues](https://github.com/DawnJson/Pro-Image-Mcp/issues)。
