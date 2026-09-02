# pro-image-mcp

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node: >=18](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![MCP: stdio](https://img.shields.io/badge/MCP-stdio-orange.svg)](https://modelcontextprotocol.io)
[![npm: pending](https://img.shields.io/badge/npm-pending%20publish-lightgrey.svg)](https://github.com/DawnJson/Pro-Image-Mcp)

一个基于 Model Context Protocol (MCP) 的 stdio 服务器，将 OpenAI 兼容的图像中转站（New API / one-api 体系）封装为标准化的图像生成与编辑工具。

[English](./README.md) | 简体中文

---

## 核心设计

`pro-image-mcp` 面向 Claude Code、Cursor、Codex 等 AI 辅助编程客户端提供图像生成支持，并在架构上坚守三条核心约束：

- **计费参数必须显式声明**：所有计费生成工具中的 `quality` 与 `size` 均为必填项，绝不在计费参数上设置静默默认值。
- **成本如实实测，拒绝猜测**：每次计费调用前后读取 `/v1/dashboard/billing/usage` 接口，精确计算并报告单次调用的真实美元消耗差值。
- **隐蔽故障显式告警**：自动检测并提示被上游静默忽略的参考图（响应中标记为 `:text2image` 流水线）、渲染与目标尺寸不一致（被后期插值放大），以及因模型族不兼容而被过滤丢弃的参数。

所有生成结果固定采用 `response_format: "url"`，由本地服务端下载存盘，仅将绝对文件路径返回给 LLM，杜绝大量图片 base64 字节挤占上下文。

## 运行环境

- Node.js >= 18.0.0
- 支持 OpenAI 兼容图像接口的中转站 API Key（如 New API / one-api 部署；默认接口地址为 `https://newapi.prorisehub.com`）

## 快速上手

### 1. 源码安装

> 说明：当前 npm 包正在准备发布中，现阶段请通过源码克隆安装。正式发布后将支持通过 `npx -y pro-image-mcp` 直接免安装运行。

```bash
git clone https://github.com/DawnJson/Pro-Image-Mcp.git
cd Pro-Image-Mcp
npm install
npm run build
```

### 2. 配置 MCP 客户端

在客户端的 MCP 配置中添加 `pro-image`——Claude Code：项目内 `.mcp.json`（或 `claude mcp add`）；Claude Desktop：`claude_desktop_config.json`；Cursor：`~/.cursor/mcp.json`。`args` 填入 `dist/index.js` 的绝对路径：

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

*在 Windows 系统中，路径可写作 `C:/path/to/Pro-Image-Mcp/dist/index.js` 以及 `C:/images-out`。*

### 3. 调用示例

向接入了该 MCP 的 AI 助手发送指令：
> *"使用 gpt-image-2 模型，quality 为 high，size 为 1024x1024，生成一张白底极简红枫叶图案。"*

## 环境变量配置

服务端通过传入的环境变量进行配置：

| 变量名 | 默认值 | 是否必填 | 说明 |
|---|---|---|---|
| `PROIMAGE_API_KEY` | *(无)* | 是 | 图像中转站的 API Key。 |
| `PROIMAGE_BASE_URL` | `https://newapi.prorisehub.com` | 否 | 中转站基础接口地址。必须为 `https`；仅当主机是 `localhost`/`127.0.0.1` 时才接受 `http`——API Key 会作为 Bearer token 出现在每个请求里，明文传输即泄露。末尾的斜杠会被自动去除。 |
| `PROIMAGE_SAVE_DIR` | `~/Pictures/pro-image-mcp` | 否 | 下载图片的本地保存目录。 |
| `PROIMAGE_DEFAULT_MODEL` | `gpt-image-2` | 否 | 未显式指定 `model` 时采用的默认模型。 |
| `PROIMAGE_TIMEOUT_MS` | `300000` | 否 | 单个 HTTP 请求超时毫秒数（默认 5 分钟）。 |
| `PROIMAGE_CONCURRENCY` | `3` | 否 | `image_batch_generate` 工具的默认并发数上限。 |

## 工具参考

| 工具 | 作用 | 核心参数 |
|---|---|---|
| `image_generate` | 通过 `/v1/images/generations` 执行文生图。 | `prompt`, `quality`*, `size`*, `model`, `n`, `save_dir`, 扩展参数 |
| `image_edit` | 通过 `/v1/images/edits` 基于单张参考图执行图生图。 | `image_path`, `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_multi_reference` | 通过 `/v1/images/edits` 融合 2–10 张参考图生成。 | `image_paths` (2–10), `prompt`, `quality`*, `size`*, `model`, `input_fidelity`, `save_dir` |
| `image_batch_generate` | 针对提示词列表进行受控并发的批量生图。 | `prompts` (1–20), `quality`*, `size`*, `model`, `concurrency`, `save_dir` |
| `list_models` | 查询可用模型列表、预估 list price 及参考图支持度。 | `filter`, `size`, `quality`, `supports` (`any` \| `image_to_image` \| `text_to_image_only`) |
| `server_info` | 查询当前服务配置、账户额度、用量支出及已测接口约束。 | *(无参数)* |

*\* `quality` (`low` \| `medium` \| `high`) 与 `size` (`WxH` 或 `auto`) 在四个生图工具中皆为严格必填项。*

### 输出审计格式示例

每次图像生成调用均返回标准审计信息块，包含执行配置、真实测量花费、渲染分辨率及告警：

```text
model=gpt-image-2  quality=low  size=1024x1024
cost=$0.02333  upstream_credits=5  quality_used=low
rendered 1024x1024
saved: /path/to/output/images/20260902-093806-771-gpt-image-2.png (1024x1024, 958KB)
```

若调用的模型族不接受 `quality` 参数，审计块中会标注为 `quality=high (not sent)`，并在下方附带说明该参数已被本地省略未发往上游。

## 模型与能力特性

- **宽高比校验策略**：合法宽高比由各模型单独决定，不存在全局通用的白名单。对已实测确认受限的模型（如 `z-image` 仅接受 `1:1`、`3:4`、`4:3`、`9:16`、`16:9` 及 `auto`），服务端在本地即刻拦截，避免几十秒的无谓等待且不产生费用；比例超出 3:1 的请求则全模型拦截；其余模型放行至上游判定。
- **按模型族过滤参数**：上游接口遇到不识别的冗余字段时通常直接返回 HTTP 200 并静默丢弃。为避免误导用户以为调节了有效旋钮，各模型族仅发送受支持的字段：

| 模型族 | 实际发往上游的字段（依据 `src/params.ts`） |
|---|---|
| `gpt-image` | `size`, `quality`, `background`, `output_format`, `output_compression`, `moderation`, `input_fidelity` |
| `gpt4o-image` | `size`, `quality`, `background` |
| `seedream` | `size`, `quality`, `seed`, `negative_prompt`, `watermark` |
| `qwen` | `size`, `seed`, `negative_prompt`, `watermark`, `prompt_extend` |
| `flux` | `size`, `seed`, `output_format` |
| `imagen` | `size`, `seed` |
| `hunyuan-image` | `size`, `quality` |
| `dalle` | `size`, `style` |
| `nano-banana`、`sora-image` | `size` |
| `z-image` | `negative_prompt` |
| `grok-imagine` | `resolution` |
| `agnes-image` | 不发送任何可选字段 |
| 未识别模型 | 宽松放行：`size`, `quality`, `seed`, `negative_prompt`, `watermark`, `background`, `output_format`, `input_fidelity` |

- **参考图被静默吞掉的检测**：部分模型在处理 `/v1/images/edits` 时会返回 HTTP 200 并接收图片上传，但实际仅依据提示词做文生图。本服务通过响应中的流水线模型后缀进行识别：`:image2image` 代表参考图真正生效，`:text2image` 代表参考图被忽略。在当前测试渠道 key 下，仅有 4 个模型（`gpt-image-2`、`nano-banana`、`qwen-image-2`、`wan2-7-image`）确认使用参考图，其余 16 个可访问模型均静默忽略。
- **能力探测脚本**：可随时针对当前密钥与渠道重新探测实际能力支持：
  ```bash
  node scripts/probe-capabilities.mjs              # 干跑试算：仅预估全量探测成本
  node scripts/probe-capabilities.mjs --confirm    # 实发探测：执行 edits 调用并输出确认映射表
  ```

## 成本与计费核算

- **实测扣费 vs. 预估价格**：基于 `/api/pricing` 计算的价格为参考标价（list price），仅供模型横向比价参考。实际扣费金额以调用前后查询 `/v1/dashboard/billing/usage` 得到的差值为准。
- **账户级用量统计机制**：中转站用量统计属于账户全局级别。如果同一 API Key 在其他客户端并发产生消费，测得的差值会包含这部分支出。批量生图工具会在整批任务开始和结束时统一测算总花费。
- **配额上限与余额区别**：`/v1/dashboard/billing/subscription` 中的 `hard_limit_usd` 是账户配额上限，并非实时余额。`server_info` 工具通过配额上限减去累计用量计算真实可用剩余额度。

## 常见问题与排错

- **缺少 API Key (`PROIMAGE_API_KEY is not set`)**：检查并确保在 MCP 客户端配置文件的 `env` 节点中正确配置了 `PROIMAGE_API_KEY`。
- **鉴权失败 (`AUTH_UNAUTHORIZED` / HTTP 401)**：确认 API Key 有效、未过期且具有中转站访问权限。
- **客户端 60 秒超时**：高分辨率出图或多图融合通常需要 15–60 秒。服务端每 5 秒会发送一次 `notifications/progress` 进度通知。若客户端不支持根据进度重置超时，请调高客户端请求超时（如在 Claude Code 中配置 `MCP_TIMEOUT=300000`）。
- **尺寸被拒错误**：当上游模型拒绝特定宽高比时，客户端会格式化报错信息并明确提示该模型支持的比例清单（如 `expected one of "1:1"|"3:4"|"4:3"|"9:16"|"16:9"|"auto"`）。
- **参考图被忽略告警**：调用 `image_edit` 或 `image_multi_reference` 时若收到 `:text2image` 告警，说明该模型在此渠道不支持真图生图，请使用 `list_models` 的 `supports="image_to_image"` 选项切换至受支持的模型。

## 开发指南

使用 npm 脚本进行本地开发与验证：

```bash
npm run build   # 编译 TypeScript (tsc) 至 dist/
npm run dev     # 监听模式 (tsc --watch)
npm run check   # 类型检查 (tsc --noEmit)
npm run smoke   # 零成本冒烟验证 (node e2e.mjs valid)
npm start       # 启动编译产物 node dist/index.js
```

### 端到端测试脚本 (`e2e.mjs`)

仓库内包含用于直连测试本地 MCP 服务的 `e2e.mjs`：

```bash
# 免费阶段（本地校验与只读查询）
node e2e.mjs valid          # 拦截测试：非法比例、非法质量、文件不存在
node e2e.mjs info,models    # 查询 server_info 与 list_models

# 计费阶段（产生真实扣费）
node e2e.mjs gen            # 单图文本生成
node e2e.mjs upscale        # 高分辨率测试与放大告警验证
node e2e.mjs edit           # 单图编辑（依赖前序 gen 生成的图片）
node e2e.mjs multiref       # 多图融合
node e2e.mjs batch          # 受控并发批量生成
```

## 安全注意事项

- 切勿将 API Key 或敏感中转站地址提交至公共代码仓库。
- 保证 `.env` 始终处于 `.gitignore` 规则中，仅通过 MCP 客户端的执行环境配置传入密钥。
- 生成的图片均存储于本地磁盘，请确保 `PROIMAGE_SAVE_DIR` 目录的文件权限符合安全要求。

## 免责声明

本项目为独立开源工具，与任何中转站运营商及上游模型供应商无官方关联、赞助或背书。文档中记录的模型表现、计费规律与能力支持为特定渠道下的实测快照，不同账户分组、渠道或节点下的实际表现可能存在差异。

## 开源许可

本项目遵循 [MIT 开源许可证](LICENSE)。如遇问题或有改进建议，欢迎提交 [GitHub Issues](https://github.com/DawnJson/Pro-Image-Mcp/issues)。
