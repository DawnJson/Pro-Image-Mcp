# pro-image-mcp

一个 MCP server，把 OpenAI 兼容的图像中转站（New API / one-api 系）包装成 Claude Code / Cursor / Codex 可直接调用的画图工具。

设计上只有一条主线：**花钱的参数必须显式写出来，花了多少钱必须如实报回来。**

## 六个工具

| 工具 | 作用 | 端点 |
|---|---|---|
| `image_generate` | 文生图 | `POST /v1/images/generations` |
| `image_edit` | 单图编辑（图生图） | `POST /v1/images/edits` |
| `image_multi_reference` | 2–10 张参考图融合 | `POST /v1/images/edits`（重复 `image[]` 字段） |
| `image_batch_generate` | 批量生图，带并发上限 | 同上，循环调用 |
| `list_models` | 模型能力表 + 按 size/quality 估算的单价，按价格升序 | `/v1/models` + `/api/pricing` |
| `server_info` | 配置、余额、已验证的 API 约束 | `/v1/dashboard/billing/subscription` |

`quality` 和 `size` 在四个生图工具里都是**必填**，不设默认值——这两个直接决定计费，静默默认等于替用户做消费决定。

## 安装

```bash
npm install
npm run build
```

## 配置

MCP 客户端配置（Claude Code 为例，写进 `.mcp.json` 或用 `claude mcp add`）：

```json
{
  "mcpServers": {
    "pro-image": {
      "command": "node",
      "args": ["E:/PostGraduateFile/code/Pro-Image-Mcp/dist/index.js"],
      "env": {
        "PROIMAGE_API_KEY": "sk-...",
        "PROIMAGE_BASE_URL": "https://us.prorisehub.com",
        "PROIMAGE_SAVE_DIR": "E:/images-out",
        "PROIMAGE_DEFAULT_MODEL": "z-image"
      }
    }
  }
}
```

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PROIMAGE_API_KEY` | 必填 | 中转站 key |
| `PROIMAGE_BASE_URL` | `https://us.prorisehub.com` | 站点地址，末尾斜杠会被去掉 |
| `PROIMAGE_SAVE_DIR` | `~/Pictures/pro-image-mcp` | 出图目录 |
| `PROIMAGE_DEFAULT_MODEL` | `z-image` | 未指定 `model` 时用它 |
| `PROIMAGE_TIMEOUT_MS` | `300000` | 单请求超时 |
| `PROIMAGE_CONCURRENCY` | `3` | 批量默认并发 |

## 计费参数

**`quality`**：`low` / `medium` / `high`。对应中转站的三个渠道分组倍率（低 1.0 / 中 1.1 / 高 1.2）。

**`size`**：`WxH` 或 `auto`。上游只认五种宽高比：

| 写法 | 比例 |
|---|---|
| `1024x1024` | 1:1 |
| `768x1024` | 3:4 |
| `1024x768` | 4:3 |
| `1024x1792` | 9:16 |
| `1792x1024` | 16:9 |

**横版要写 `1792x1024`，不是 `1536x1024`**——3:2 会被上游拒绝。

每次调用返回的审计信息：

```
model=z-image  quality=low  size=1024x1024
credits_charged=8  quality_used=low
rendered 1024x1024
saved: E:\images-out\20260902-085821-525-z-image.png (1024x1024, 1.2MB)
```

## 计价模型

从 `/api/pricing` 的 `sku_ratios` 字段解出来的完整公式：

```
实际价格 = model_price
         × 长边档位倍率      (每个模型有自己的档位表，18/20 适用)
         × quality 倍率      (只有 gpt-image-1-5 和 gpt-image-2 适用)
         × 渠道分组倍率      (低 1.0 / 中 1.1 / 高 1.2，由 key 决定)
```

**长边档位表是 per-model 的，不能硬编码一张全局表**：

| 模型 | 1K | 2K | 3K | 4K |
|---|---|---|---|---|
| 通用规则（16 个模型） | 0.70 | 0.85 | 0.95 | 1.00 |
| `nano-banana` | **0.50** | **0.75** | 1.00 | 1.00 |
| `z-image` / `flux-2-klein-9b` | 固定价，不分档 | | | |

`quality` 的 SKU 倍率（`low 0.7 / medium 0.85 / high 1.0`）**只对 `gpt-image-1-5` 和 `gpt-image-2` 生效**。其余 18 个模型改 quality 不改变 `credits_charged`，只通过 key 的渠道分组倍率影响账单——这解释了为什么实测 z-image 在 low/medium/high 三档都是 8 credits。

`list_models` 会按你给的 `size` 和 `quality` 实时算出每个模型的估价并给出推导过程：

```
nano-banana  $0.05
    price:      $0.06666667 base x0.75 (2K)
    image input: yes (verified) - confirmed by a live /v1/images/edits call
```

## 模型能力表

中转站**不提供任何能力标志位**——20 个图像模型的 `tags` 全是「图像」，`supported_endpoint_types` 也不相关（nano-banana 支持图生图却只标 `openai`，flux-1-dev 标了 `image-generation` 却只能文生图）。

所以 `list_models` 的图生图能力分三级可信度：

| 标记 | 含义 |
|---|---|
| `yes (verified)` | 真发过 `/v1/images/edits` 确认过 |
| `yes (from description)` | 从厂商描述里的「图生图」「多图上下文」等关键词推断，**可能错** |
| `no (from description)` | 描述里只提文生图 |
| `unknown` | 描述没有有效信息 |

用 `supports: "image_to_image"` 过滤出能喂图的模型，再去调 `image_edit` / `image_multi_reference`。

要把推断换成实测，跑：

```bash
node scripts/probe-capabilities.mjs              # 干跑，只报价
node scripts/probe-capabilities.mjs --confirm    # 真花钱，全量约 $0.68
```

脚本会对每个模型发一次真实的图生图请求，并输出可直接粘贴进 `src/capabilities.ts` 的 `VERIFIED_IMAGE_TO_IMAGE` 代码块。它还会检查 `references_uploaded > 0`——有的模型会返回 200 但其实忽略了参考图，那不算真支持。

## 实测确认的上游行为

以下每一条都是对 `us.prorisehub.com` 实际发请求验证过的，不是推测。代码里针对每条都有对应处理：

1. **宽高比白名单**。只接受 1:1 / 3:4 / 4:3 / 9:16 / 16:9 / auto。`1536x1024`（3:2）返回 HTTP 500。
   → 本地先校验，不合法的尺寸 0ms 拒绝，不产生费用。

2. **`quality` 上游完全不校验**。传 `quality:"ultra"` 返回 200，且 `_meta.quality_used` 原样回显 `"ultra"`。一个拼写错误会静默按未知档位计费。
   → 用 Zod enum 在 schema 层白名单，客户端就挡掉。

3. **`size_downgraded` 字段不可信**。请求 `4096x4096` 时实际 `generation_size=1360x1360`、`target_size=4096x4096`（生成后放大），但 `size_downgraded` 仍为 `false`。
   → 自己比对 `generation_size` vs `target_size`，不一致就发 `WARNING: 你付了 4096 的钱但只渲染了 1360，其余是放大而非细节`。

4. **返回的图片 URL 带前导空格**：`" https://cdn.prorisehub.com/xxx.png"`。
   → 下载前一律 `.trim()`。

5. **`b64_json` 体积失控**。2048×2048 的 base64 是 14.9MB。
   → 固定走 `response_format: "url"`，服务端下载存盘，**只把文件路径返回给模型**，图片字节永不进上下文。

6. **mask 被接受但被忽略**（`_meta.mask_received_but_ignored`）。
   → 不暴露 mask 参数，免得用户以为能用。

7. **错误信息套两层**。外层 `{"error":{"message":"400: {\"error\":\"...\"}"}}`，且 HTTP 码不规范（模型不存在返 503、参数错误返 500、空 prompt 返 422）。
   → 客户端剥两层再抛，让用户看到真实原因。

8. **生图耗时 15–60s**，多图融合实测 60.1s，会撞上多数 MCP 客户端默认的 60s 请求超时。
   → 每 5s 发一次 `notifications/progress` 心跳，支持 `resetTimeoutOnProgress` 的客户端会重置计时器。若客户端不支持，可调高其超时（Claude Code 用 `MCP_TIMEOUT`）。

## 冒烟测试

```bash
PROIMAGE_API_KEY=sk-... node e2e.mjs valid      # 本地校验，不花钱
PROIMAGE_API_KEY=sk-... node e2e.mjs info,models
PROIMAGE_API_KEY=sk-... node e2e.mjs gen,edit,multiref,batch   # 会真实计费
```

`valid` 一档覆盖三条零成本拦截：非法比例、非法 quality、文件不存在。
