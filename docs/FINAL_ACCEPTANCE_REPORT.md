# 网络与配额隔离改动终审验收报告

## 一、验收结论

**裁决：通过。** 本次检查的当前工作区实现满足本任务列出的配额证据、五分钟新鲜度、模型族隔离、403 保守分类、OAuth 吊销边界，以及网络失败不写账号状态等要求。独立专项测试与全量验证均通过，未发现阻断验收的代码问题。

## 二、审查范围与方法

- 按要求检查 `src/adapter/adapter.ts`、`src/runtime/classify.ts`、`src/runtime/rotation.ts`、`src/session.ts`、`tests/network-quota-isolation.test.ts` 和 `tests/runtime.test.ts`，并追踪缓存写入路径及相关 adapter/session 测试。
- 对照阅读 `docs/REVIEW_REPORT.md`。该报告记录的是较早状态：当前实现已改为同时检查 `cachedLimits`，专项测试已从报告所述 5 项扩充为 44 项；报告指出的“Retry-After 被覆盖”也已由当前代码和测试修正。因此不能把该旧报告中的阻塞项直接当作当前结论。
- 按要求未打开或读取 `docs/ARCH_EVALUATION_REPORT.md`。
- 当前分支为 `feat/network-quota-isolation`。需要注意，`git diff main...HEAD` 中目前只有 `docs/ARCH_EVALUATION_REPORT.md`；本次被验收的源代码和测试变动仍在工作区（含未跟踪文件），并非已经提交到分支 HEAD。以下 PASS 针对当前工作区快照，不代表这些改动已进入提交。

## 三、逐项审查结果

### 1. 429 硬耗尽证据与隔离

- `src/adapter/adapter.ts` 对 429 不再根据 `RESOURCE_EXHAUSTED` 或文案直接判定硬耗尽，而是要求对应模型族存在缓存余额证据；没有证据时保持可重试限流。
- 新鲜度统一检查缓存的 `updatedAt`：时间必须是有限意义上的有效数字、不得来自未来，且年龄不得超过 5 分钟。恰好 5 分钟仍有效，测试已覆盖边界。
- 判定使用 `familyKeyOf(options.model)` 选取调度配额，并仅检查相匹配的限额组。测试覆盖 Gemini/Google 与 Claude、GPT、3P 的正向映射，以及 Google 与第三方互不串用、未知模型不误提级。
- 生产写入来源已核实：管理端 `refreshLimits()` 将新鲜观测写入 `cachedLimits`，429 判定实际消费该字段。因此即使调度配额缓存没有在某条使用路径中刷新，已存在的限额快照仍能作为真实证据；单独存在但过期或错族的观测不会升级为终端配额耗尽。
- 周额度仅在周窗口、余额不高于 0.5%、且有 reset 值时作为近耗尽证据；其余窗口要求精确的零余额。这避免仅凭模糊低余额或无重置依据将账号长时间停用。
- 有效 `Retry-After >= 3s` 且无硬耗尽证据时保留 `rate_limited`；短于 3 秒的提示归入 `soft_rate_limit`。两种路径都保留并传递上游重试时间。fresh 同族零余额证据仍优先升级为 `quota_exhausted`，并返回终端 `QUOTA`。

### 2. HTTP 分类与凭证吊销

- 生成端点的 401 和普通 403（包括 `RESOURCE_EXHAUSTED`、权限拒绝或封禁文案）均分类为 `transient`，不会仅凭端点响应吊销 OAuth 凭证。
- 403 只有结构化字段明确包含 `VALIDATION_REQUIRED` 时才进入 `verification-required`；这是单独的限时验证状态，不等同凭证撤销。
- `auth-failure` 的生成端分类路径已移除。OAuth 刷新仍只在明确的 `invalid_grant`（且所有候选客户端凭证均被明确拒绝）后返回 `revoked` 并禁用账号；网络或其他暂态失败不会冒充撤销。
- `tests/runtime.test.ts` 对普通 403、配额文案、验证挑战和疑似封禁均使用与新语义一致的用例名和断言，没有发现旧报告所述的“真封禁终端”注释与 transient 断言矛盾。

### 3. 网络／代理故障的无写权限与原地重试

- `classifyFetchError()` 仅在显式账号代理路由下，才把裸 socket 错误归为 `proxy-unreachable`；取消/中止归入 `request-error`，普通连接异常归入 `network-error`。
- `decideRotation()` 对 `network-error` 与 `proxy-unreachable` 返回 `retry`，不会写冷却字段或改变账号启用状态。
- `AgySessionManager.reportFailure()` 在进入 `store.mutate()` 之前，对 `network-error`、`proxy-unreachable`、`request-error` 及软限流直接返回；这些失败不启动持久化事务、不变更 `activeIndex`、不记冷却、不写验证状态。流空闲超时走 `network-error` 路径，遵守相同边界。
- 现有 session 回归测试验证网络错误之后账号未冷却、池游标未移动并继续选择原账号；新增专项测试验证显式代理的 `ECONNRESET`/`ETIMEDOUT` 分类及无账号状态污染的轮转决策。

### 4. 测试覆盖与一致性

- `tests/network-quota-isolation.test.ts` 共 44 项，涵盖网络/代理失败、403 保守分类、结构化验证挑战、429 四类结果、缓存缺失/陈旧/未来时间、五分钟边界、同族与跨族隔离、周额度边界，以及 `Retry-After` 保留。
- `tests/runtime.test.ts` 的 403、刷新吊销、限流分类及轮转语义与实现一致；原有网络错误不冷却/不轮转测试仍存在。
- adapter 专项断言通过真实 adapter 错误映射验证：硬耗尽为 `QUOTA`，软限流与有效 `Retry-After` 为 `RATE_LIMIT`，失败报告收到匹配类别、模型和延迟。
- 全量测试中的 15 个 skipped 测试为现有显式跳过项，不是失败；本次没有为追求全绿而更改或解禁它们。

## 四、验证结果

- `pnpm run typecheck`：通过，退出码 0。
- `pnpm test`：通过；27 个测试文件通过，807 项通过、15 项跳过、0 项失败（总计 822 项）。
- 测试均为仓库 Vitest 套件；本次没有执行 live-network 验证脚本。

## 五、非阻断说明

- `classifyRateLimit()` 仍接收 `bodyText` 参数，但现行保守分类不再读取它；这是可清理的未使用参数，不影响行为或类型检查。
- 验收对象是当前工作区快照。合并或发布前，应确认 `src/`、测试与本报告均已按预期纳入提交，再对最终提交运行同样的两项验证。

【FINAL_VERDICT: PASS】
