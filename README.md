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
| `list_models` | 模型能力表 + 参考图支持度 + list price，按价格升序 | `/v1/models` + `/api/pricing` |
| `server_info` | 配置、配额/已用/剩余、已验证的 API 约束 | `/v1/dashboard/billing/{subscription,usage}` |

`quality` 和 `size` 在四个生图工具里都是**必填**，不设默认值——这两个直接决定计费，静默默认等于替用户做消费决定。对不接受 `quality` 的模型族，它仍然必填但不会发上去（见「按模型族发参」）。

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
        "PROIMAGE_DEFAULT_MODEL": "gpt-image-2"
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
| `PROIMAGE_DEFAULT_MODEL` | `gpt-image-2` | 未指定 `model` 时用它 |
| `PROIMAGE_TIMEOUT_MS` | `300000` | 单请求超时 |
| `PROIMAGE_CONCURRENCY` | `3` | 批量默认并发 |

## 两个必填参数

**`quality`**：`low` / `medium` / `high`。指**生成时的图像质量**——模型在这张图上花多少力气。

> `quality` 和中转站的「图像-低 / 图像-中 / 图像-高」三个渠道分组**是两个不同的维度，不是对应关系**。分组表示**用哪个来源出图**，由 key 决定、不能按请求指定；`quality` 是请求参数，决定这次生成的质量档。
>
> 站方对三个分组的描述（取自 `/api/pricing` 的 `usable_group`）：
>
> | 分组 | 站方描述 |
> |---|---|
> | 图像-低 | 聚合/逆向渠道，质量参差，**功能受限** |
> | 图像-中 | 聚合站渠道，**参数大致透传，可能有遗漏** |
> | 图像-高 | 官方/官方 Agent 渠道，**参数全透传**，最高画质 |
>
> 两者虽然独立，但**分组会限制 `quality` 能不能真正生效**。实测用图像-低的 key 调 `gpt-image-2` 传 `quality:"high"`，返回 `quality_used:"medium"` 且 `downgraded:true`——因为逆向渠道参数透传不全。本 MCP 会把这种情况升级成显式告警。

**`size`**：像素 `WxH` 或 `auto`（`auto` 表示不指定，由模型自己决定）。

**合法宽高比是 per-model 的，不存在一张全局白名单。** 实测：

| 尺寸 | 比例 | z-image | gpt-image-2 |
|---|---|---|---|
| `1024x1024` | 1:1 | ✅ | ✅ |
| `1792x1024` | 16:9 | ✅ | ✅ |
| `1536x1024` | 3:2 | ❌ HTTP 500 | ✅ |
| `2016x864` | 21:9 | 未测 | ✅ |

z-image 报错原文是 `expected one of "1:1"|"3:4"|"4:3"|"9:16"|"16:9"|"auto"`，而 gpt-image-2 对同一尺寸正常出图。

因为**失败的请求不计费、只是白等几十秒**，所以误拦一个本可成功的尺寸比放过一个必然失败的更糟。校验策略据此设计：

| 检查 | 行为 |
|---|---|
| 格式非 `WxH`/`auto`、尺寸非正 | **硬拦** |
| 宽高比 > 3:1 | **硬拦**（上游统一上限） |
| 已证实受限的模型（目前只有 `z-image`）用了它不支持的比例 | **硬拦**，并提示其他模型限制更松 |
| 长边 > 3840、总像素越界、非 16 倍数 | **放行 + NOTE**，不阻断 |
| 其他模型的任意比例 | **放行**，让上游裁决 |

若上游仍然拒绝，客户端会把它那句 `expected one of ...` 解析出来，转成「该模型只接受 X、Y、Z 比例」的人话错误。

`RESTRICTED_RATIO_MODELS` 只登记**实测确认过**的模型——往里乱加会拦掉合法请求。

每次调用返回的审计信息，`cost` 是**实测**的真实花费：

```
model=gpt-image-2  quality=low  size=1024x1024
cost=$0.02333  upstream_credits=5  quality_used=low
rendered 1024x1024
saved: E:\images-out\20260902-093806-771-gpt-image-2.png (1024x1024, 958KB)
```

## 成本是量出来的，不是算出来的

`_meta.credits_charged` **不是你的账单**——它是上游来源（站方转售的 openart 账号）的内部 credit，和美元不成比例：

| 模型 | `credits_charged` | pricing 单价 |
|---|---|---|
| flux-1-dev | 5 | $0.025 |
| z-image | 8 | $0.015 |
| gpt-image-2 (low) | 5 | $0.10 |

而按 `sku_ratios` 公式算出来的价格，实测下来**稳定是真实扣费的两倍**，且分组倍率解释不了这个系数：

| 模型 | 公式预测 | 实测扣费 | 比值 |
|---|---|---|---|
| z-image | $0.015 | $0.0075 | 0.5 |
| nano-banana | $0.0333 | $0.01667 | 0.5 |
| gpt-image-2 | $0.04667 | $0.02333 | 0.5 |

所以本 MCP **不猜价格**：每次生图前后各读一次 `/v1/dashboard/billing/usage`（`total_usage` 单位是美分），用差值报告真实花费。`list_models` 里的价格标注为 **list price**，只用于横向比较模型贵贱。

> 注意：用量是账户级的，如果同一账号在别处并发消费，差值会偏大。批量生图只在整批前后各测一次，不逐张测。

另外 `/v1/dashboard/billing/subscription` 的 `hard_limit_usd` 是**配额上限**，不随消费变动，不能当余额读。`server_info` 用它减去 usage 才得出真正的剩余额度。

## 计价模型

从 `/api/pricing` 的 `sku_ratios` 字段解出来的完整公式：

```
实际价格 = model_price
         × 长边档位倍率      (每个模型有自己的档位表，18/20 适用)
         × quality 倍率      (只有 gpt-image-1-5 和 gpt-image-2 适用)
         × 渠道分组倍率      (图像-低 1.0 / 图像-中 1.1 / 图像-高 1.2)
                             ↑ 这是「用哪个生成来源」，由 key 固定，
                               与上面那个 quality 参数无关
```

**长边档位表是 per-model 的，不能硬编码一张全局表**：

| 模型 | 1K | 2K | 3K | 4K |
|---|---|---|---|---|
| 通用规则（16 个模型） | 0.70 | 0.85 | 0.95 | 1.00 |
| `nano-banana` | **0.50** | **0.75** | 1.00 | 1.00 |
| `z-image` / `flux-2-klein-9b` | 固定价，不分档 | | | |

`quality` 的 SKU 倍率（`low 0.7 / medium 0.85 / high 1.0`）**只对 `gpt-image-1-5` 和 `gpt-image-2` 生效**。其余 18 个模型带的是纯 size 规则或固定价，改 quality 不改变 `credits_charged`——这解释了为什么实测 z-image 在 low/medium/high 三档都收 8 credits。注意这只是说**计价**不受影响，`quality` 对这些模型的**出图效果**是否有影响要另行验证。

最后那道渠道分组倍率本 MCP **算不出来**：分组是 key 的属性，接口不回传，所以 `list_models` 的估价止步于分组倍率之前，只报「乘分组倍率之前」的价格。

`list_models` 会按你给的 `size` 和 `quality` 实时算出每个模型的估价并给出推导过程：

```
nano-banana  $0.05
    list price: $0.06666667 base x0.75 (2K)
    image input: YES (measured) - a live edits call came back as :image2image
```

价格标 **list price** 是因为它算不准（见上一节）；真实花费由生图工具实测报告。

## 模型能力表

中转站**不提供任何能力标志位**——20 个图像模型的 `tags` 全是「图像」，`supported_endpoint_types` 也不相关（nano-banana 支持图生图却只标 `openai`，flux-1-dev 标了 `image-generation` 却只能文生图）。

### 最危险的失败模式：参考图被静默吞掉

有的模型对 `/v1/images/edits` **返回 200、`references_uploaded=1`、正常出图、正常扣费——但根本没看你的参考图**，纯按 prompt 文生图。用户拿到一张看着挺合理的图，完全不知道参考图没起作用。

判别信号在响应的 `model` 字段后缀：

| 响应 `model` | 含义 |
|---|---|
| `nano-banana:image2image` | 参考图**真的被用了** |
| `z-image:text2image` | 参考图被吞，实际只按 prompt 生成 |

**`references_uploaded` 不能用来判断**——它只说明字节传到了，两种情况下都是 1。

本 MCP 在 `image_edit` / `image_multi_reference` 里检查这个后缀，命中 `:text2image` 就发显式 WARNING。

### 可信度分级

`list_models` 的 `image input` 字段：

| 标记 | 来源 |
|---|---|
| `YES (measured)` | 实发过 edits，响应后缀是 `:image2image` |
| `NO (measured - reference silently ignored)` | 实发过，后缀是 `:text2image` |
| `probably yes/no (prolab family)` | 按 prolab 的 `detectModelFamily` + `IMAGE_MODEL_REGISTRY` 分族推断 |
| `unknown` | 无族匹配 |

**厂商描述已被弃用为判据**：z-image 的官方描述写着「文生图/图生图模型」，在这个中转站上实测却是 `:text2image`，参考图直接丢弃。

> 注意 prolab **不能**用来佐证这一点。它的 registry 里 z-image 条目根本没有 `referenceImage` 这个 key（是「未声明」而非显式 `false`），`image-body-builder.ts` 的 `case 'z-image'` 注释只写「仅 negative_prompt」，并没有说上游不支持——对比 agnes-image 和 hunyuan，那两个才明确写了「实测上游忽略」。所以 prolab 只能说明**它自己没做**这条支持。判定 z-image 的唯一依据是本站的实测结果。
>
> 同理，族先验的**否定项一律降级为 `unknown`** 而非「大概率不支持」：prolab 是省略能力声明，不是否认能力，两者无法区分。只有实测能排除一个模型。

已实测的三个：

| 模型 | 结果 |
|---|---|
| `nano-banana` | ✅ 真图生图 |
| `byte-plus-seedream-4-5` | ❌ 传 2 张参考图仍走 text2image |
| `z-image` | ❌ 同上 |

族先验里的参考图上限（取自 prolab）：gpt-image 16 张、seedream 10 张、flux 8 张、grok/qwen 3 张。

用 `supports: "image_to_image"` 过滤后再调 `image_edit` / `image_multi_reference`。

要把推断换成实测：

```bash
node scripts/probe-capabilities.mjs              # 干跑，只报价
node scripts/probe-capabilities.mjs --confirm    # 真花钱，全量约 $0.68
```

脚本按 `:image2image` 后缀判定，输出可直接粘贴进 `src/capabilities.ts` 的 `MEASURED_IMAGE_TO_IMAGE` 代码块。

## 按模型族发参

prolab 对每个模型族构造**不同的请求体**，不是一个并集。本 MCP 照抄了它的字段表（`src/params.ts`），族不接受的字段**不发**，并在结果里说明。

理由和参考图那条一样：上游对多余字段一律返回 200，不匹配是**看不见的**。用户在 nano-banana 上设了 `quality`，以为拧了个旋钮，其实那根线没接。

| 字段 | 接受的族 |
|---|---|
| `size` | 除 grok/agnes 外几乎都接受 |
| `quality` | gpt-image、seedream、hunyuan、gpt4o |
| `seed` | flux、imagen、seedream、qwen |
| `negative_prompt` | seedream、qwen、z-image |
| `watermark` | seedream、qwen |
| `background` | gpt-image、gpt4o（`transparent` 出透明底素材） |
| `output_format` | gpt-image、flux |
| `input_fidelity` | **仅 gpt-image**，控制编辑时保留原图的程度 |

`quality` 在 schema 层**仍然必填**（计费安全），但对不接受它的族不会发上去，结果行会标 `(not sent)`：

```
model=flux-2-klein-9b  quality=high (not sent)  size=1024x1024
cost=$0.00750  upstream_credits=5

NOTE: quality, negative_prompt were NOT sent: the "flux" family does not
accept them. The request was made without them.
```

`image_multi_reference` 会按族上限拒绝过多参考图：gpt-image 16、seedream 10、flux 8、qwen/grok 3。

### 关于 `n`

`image_generate` 的 `n` 可以大于 1，但 prolab **恒发 n=1**，改用并发的独立请求，注释写明理由是「避免上游二次批量造成双重计费」。要多张图请优先用 `image_batch_generate`，它就是这个模式。

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
