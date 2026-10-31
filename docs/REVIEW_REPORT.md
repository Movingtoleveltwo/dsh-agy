# 独立盲审报告

**最终裁决：REQUEST_CHANGES 需整改**

**验证结果**
- `pnpm test`：27 个文件 768 通过、15 跳过，含新增 `tests/network-quota-isolation.test.ts`（5 个用例）。
- `pnpm run typecheck`：通过。
- 目标 1（网络/软限流写权限归零）与目标 2（403 防误判）语义基本达成，但目标 3 的核心机制在真实链路中不可达，并有 1 处与断言自相矛盾的回归。

**阻塞项**

- `src/adapter/adapter.ts:611` 的 429 硬耗尽判定读取 `session.account.cachedQuota` 与 `cachedQuotaUpdatedAt`，但生产代码**从不写这两个字段**。唯一写入点是 `refreshQuotaCache`（`src/session.ts:710`），全库零调用；可接线的是 `refreshLimits`（`src/session.ts:622`），它只写 `cachedLimits` 不写 `cachedQuota`。`tests/session.test.ts` 里 3 个 `it.skip` 明确标注 “custom manual account mode does not run scheduling quota refresh on getSession”。因此 `zero`（`src/adapter/adapter.ts:615`）恒为 `false`，每个 429 都被降级为 `soft_rate_limit`，终端 `QUOTA` 分支永不可达，且无任何测试覆盖“0%→QUOTA 提级”或“Gemini 认 Gemini 桶、不串 Claude 桶”的隔离。这要么是机制未接通，要么应删除/注释掉这段看似有效实则永不触发的裁决代码。

**高优先级**

- `src/runtime/classify.ts:171-193` 现在把 401、普通 403（含封禁）一律转 `transient`。这确实消除了“端点链末 403 误定罪”，但连带取消了“真封禁/挂起账号”的吊销路径——如今仅剩 OAuth refresh `invalid_grant`（`classifyRefreshFailure`）仍能触发 `auth-failure`。`tests/runtime.test.ts:103-110` 的注释“A genuine ban is still terminal”与断言 `expect(banned.kind).toBe('transient')` 直接矛盾，说明该回归未做显式决策。

**中优先级**

- `src/adapter/adapter.ts:615-617` 对 429 无条件覆写 `rateLimitCategory` 为 `quota_exhausted` 或 `soft_rate_limit`，抹掉了 `rate_limited`（`Retry-After >= 3s` 的每分钟限流）。后果：`src/session.ts:1191` 的家族级 `rateLimitResetTimes` 记账与指纹重建（仅对非 `soft` 生效）在生成路径永久失效。若“原地退避”确为有意，需明确写进注释/规范；否则应保留带 `retryAfterMs` 驱动的 `rate_limited`。

**低优先级（清理/确认）**

- `src/runtime/classify.ts:95` 的 `QUOTA_EXHAUSTED_KEYWORDS` 与 `:108` 的 `const text` 已成死代码（tsconfig 未开 `noUnusedLocals`，typecheck 不报）；`classifyRateLimit` 末行的 `rate_limited` 分支不可达。
- 测试名漂移：`tests/runtime.test.ts:88` 仍叫 “…as rate-limit”，实际断言 `transient`。
- `isVerificationRequired`（`src/runtime/classify.ts:39`）改为对 `error.status/message/code` 的整串等值匹配：蛇形 `validation_required` 经 `toUpperCase()` 可命中，但带空格/分词形式不会。规格要求结构化挑战，方向正确，但建议书面确认上游真实字段与值形。

**做得对的部分**
- `src/session.ts:1185-1188` 对 `network-error`/`proxy-unreachable`/`request-error`/`soft_rate_limit` 在进入 `store.mutate` 前直接返回，无锁、无事务、无账号状态写入，满足目标 1。
- `src/runtime/rotation.ts:352` `proxy-unreachable` 由 `rotate` 改为 `retry`，与“原地重试、不改 `activeIndex`、不打冷却/验证标记”一致。
- 普通 403 不再打 `verificationRequired`/`auth-failure`，仅结构化 `VALIDATION_REQUIRED` 进验证态，满足了目标 2 的核心诉求。

**建议的整改动作**
1. 接通 `cachedQuota` 的生产写入路径（或改用已在用的 `cachedLimits` 数据源），并补两组集成测试：同家族 fresh 0% 提级为 `QUOTA`、跨家族零值**不**提级。
2. 明确“真封禁仍应吊销”还是“彻底放弃 generation-403 吊销”，并同步修正 `tests/runtime.test.ts` 的注释与断言。
3. 决定 `rate_limited` 是否保留，保留则别在 adapter 全部覆写为 `soft_rate_limit`。
4. 清理死代码与漂移的测试名。