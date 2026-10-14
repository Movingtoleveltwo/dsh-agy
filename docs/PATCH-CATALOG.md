# dsh-agy 自研定制补丁全景清单与维护台账 (Patch Catalog)

> **版本基线**：Upstream `chaos-03x/dsh-agy` v0.4.6  
> **生产检查锚点**：Tag `v0.4.6-custom.1`（Commit `bfd30d0`）  
> **维护仓库**：`Movingtoleveltwo/dsh-agy`  
> **验证基线**：26 个测试套件，**763 项测试全部通过**（含 34 项 Codex 零网络极端边界与并发破坏性探针）  
> **审查验收凭证**：Codex Round 1~4 复审缺陷彻底闭环 + 官方 `agy` CLI 无头模式独立终审通过  
> **更新指南**：未来每次跟进官方更新（v0.4.7+）时，切勿盲目全量覆盖，必须对照本台账的 14 项补丁逐项核对与验收。

---

## 一、补丁总览与依赖拓扑

```
[模块一：Hermes 中继生命线] ──> /agy/v1 端点 (P1~P5) ──> 供给 Hermes Agent 外部直连
[模块二：调度与生命周期]   ──> 贪心串行接力 + 严格单号探测 + 网络抖动禁切号 (P6~P10)
[模块三：协议正规化]       ──> Gemini 轮次交替与孤立响应清洗 (P11)
[模块四：前端交互 UI]       ──> 双栏主从布局 + 上下双层满宽进度条 + 复合高精度倒计时 (P12~P14)
```

---

## 二、自研补丁清单明细

### 模块一：Hermes 中继生命线 (`/agy/v1` Relay)

| 编号 | 补丁名称 | 核心文件 | 关键实现要点与保护规则 |
|---|---|---|---|
| **P1** | `/agy/v1` 协议中继桥 | `src/web/openai-relay.ts`<br>`src/web/plugin.ts` | 暴露 `/agy/v1/chat/completions` 与 `/agy/v1/models`；提供 OpenAI 兼容的流式与非流式通道；随插件随路启动。 |
| **P2** | 0-based 工具槽位追踪 | `src/web/openai-relay.ts` | `ToolSlotTracker` 将引擎内部跨轮次 block 递增索引连续映射为 0-based 数组下标，防止 OpenAI 客户端数组越界崩溃。 |
| **P3** | 延迟头提交与重试退避 | `src/web/openai-relay.ts` | 首个 Chunk 到达前不发 HTTP 200；429 硬耗尽自动向顺延新号重试一次；`RATE_LIMIT` 突发软限流严格执行 `waitRetryDelay`。 |
| **P4** | 多工具 Fallback ID 独立递增 | `src/adapter/parse.ts` | `closeBlock()` 必须在计算 fallback `upstreamId` 前执行，确保 `blockIndex` 递增，防止连续 tool call 参数被拼成非法 JSON。 |
| **P5** | 内存图像直通与安全清理 | `src/adapter/adapter.ts` | `registerMemoryImage` / `clearMemoryImage`：支持 Base64 内存图片直通与单次请求后自动释放，杜绝多模态图片丢失。 |

---

### 模块二：调度与生命周期 (Session & Rotation)

| 编号 | 补丁名称 | 核心文件 | 关键实现要点与保护规则 |
|---|---|---|---|
| **P6** | 贪心串行用尽顺延接力 | `src/session.ts`<br>`src/runtime/rotation.ts` | **单号粘性**：当前活跃号未冷却前 100% 独宠使用，绝不跨号轮换；**耗尽顺延**：429 进冷却才顺延切号（$A \to B \to C \to A$）；**解冻不抢占**：先前账号冷却结束不抢占回切。 |
| **P7** | 单号防关联探测隔离 | `src/session.ts` | `refreshLimits` 严格限制只探测当前 `storage.activeIndex` 对应账号，**严禁向池内多号并发探测配额**，防 Google 关联整池封号。 |
| **P8** | 网络波动禁切号策略 | `src/runtime/rotation.ts` | `network-error` 严格返回 `{ action: 'retry' }` 原地退避重试，**严禁写入 `coolingDownUntil`，严禁触发切号**。 |
| **P9** | 精确重置对齐与防早解冻 | `src/runtime/rotation.ts` | 429 报错优先对齐已知的真实周/5h 重置时间；`clearExpiredState` 在到期解冻时核验周限额，若仍为 0% 严禁提前解冻并自动顺延。 |
| **P10** | 游标原子锁与迟到保护 | `src/session.ts` | 选号与游标写入在 `store.mutate` 锁内按稳定账号 Key 完成；迟到的旧会话失败若当前号已变化，绝不覆盖当前活跃号。 |

---

### 模块三：协议兼容 (Turn Normalization)

| 编号 | 补丁名称 | 核心文件 | 关键实现要点与保护规则 |
|---|---|---|---|
| **P11** | Gemini 轮次交替正规化 | `src/adapter/translate.ts` | 合并连续同角色轮次；首个非系统轮次为 model 时自动补齐 `[Context continuation]`；孤立函数响应降级为文本，杜绝 Google 400 报 `function call turn must come after user`。 |

---

### 模块四：前端交互 UI (Client Accounts UI)

| 编号 | 补丁名称 | 核心文件 | 关键实现要点与保护规则 |
|---|---|---|---|
| **P12** | 左主右详双栏布局 | `src/client/index.ts` | 左侧垂直排布【账号列表】+【限额进度条卡片】；右侧完整保留【详情】+【操作】+【用量】+【代理】卡片。 |
| **P13** | 上下双层满宽进度条 | `src/client/styles.ts` | 上层（两端对齐）：周期名称 + 倒计时 + 彩色百分比；下层独占一行 100% 满宽轨道，采用宿主主题语义 Token。 |
| **P14** | 复合高精度倒计时语义 | `src/client/quota-view.ts`<br>`src/client/locales.ts` | 已过重置时间明确显示「重置周期已过」（杜绝“即将”歧义）；未到时间复合格式化为「将在 X 小时 Y 分钟后重置」与「将在 D 天 H 小时后重置」。 |

---

## 三、升级更新操作 SOP (Standard Operating Procedure)

当官方发布新版本（例如 `v0.4.7`）时，执行以下标准流程：

1. **备份数据与锚点**：
   ```bash
   cp ~/.dsh/agy/agy-accounts.json ~/.dsh/agy/agy-accounts.json.bak_upgrade
   git -C /home/ga/dsh/plugins/dsh-agy branch backup/pre-upgrade HEAD
   ```
2. **切入隔离分支合并**：
   ```bash
   git checkout -B upgrade/new-upstream
   git merge upstream/main
   ```
3. **对照本清单逐项核查**：
   - 重点检查 `src/session.ts`、`src/runtime/rotation.ts`、`src/web/openai-relay.ts` 是否被上游原版覆盖；
   - 检查前端 `src/client/index.ts`、`styles.ts` 是否保持 P12、P13、P14 布局与语义。
4. **全量回归验证**：
   ```bash
   pnpm test
   pnpm build
   systemctl --user restart dsh-web.service
   bash /home/ga/.hermes/skills/devops/dsh-plugin-maintenance/scripts/relay-smoke.sh
   ```
5. **合入主干并推送**：
   ```bash
   git checkout main && git merge upgrade/new-upstream
   git push origin main
   ```
