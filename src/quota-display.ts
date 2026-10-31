import type { GeminiModelQuotaSnapshot, QuotaGroup } from './types.ts'

export function isGeminiQuotaGroup(group: QuotaGroup): boolean {
  return group.name.toLowerCase().includes('gemini')
    || group.windows.some((window) => window.bucketId.toLowerCase().startsWith('gemini-'))
}

export function filterGeminiQuotaGroups(groups: readonly QuotaGroup[] | null | undefined): QuotaGroup[] {
  return (groups ?? []).filter(isGeminiQuotaGroup)
}

export function displayGeminiQuota(
  groups: readonly QuotaGroup[] | null | undefined,
  groupedUpdatedAt: number | null | undefined,
  modelQuota: GeminiModelQuotaSnapshot | null | undefined,
): { groups: QuotaGroup[] | null; updatedAt: number | null } {
  const geminiGroups = filterGeminiQuotaGroups(groups)
  const hasRollingWindow = geminiGroups.some((group) => group.windows.some((window) => window.window === '5h'))
  if (hasRollingWindow || modelQuota === null || modelQuota === undefined) {
    return {
      groups: geminiGroups.length > 0 ? geminiGroups : null,
      updatedAt: geminiGroups.length > 0 ? groupedUpdatedAt ?? null : null,
    }
  }
  const rollingWindow = {
    bucketId: 'gemini-models-5h',
    window: '5h',
    remainingFraction: modelQuota.remainingFraction,
    resetTime: modelQuota.resetTime,
  }
  const [first, ...rest] = geminiGroups
  return {
    groups: first === undefined
      ? [{ name: 'Gemini Models', windows: [rollingWindow] }]
      : [{ ...first, windows: [...first.windows, rollingWindow] }, ...rest],
    updatedAt: first === undefined || groupedUpdatedAt === null || groupedUpdatedAt === undefined
      ? modelQuota.updatedAt
      : Math.min(groupedUpdatedAt, modelQuota.updatedAt),
  }
}
