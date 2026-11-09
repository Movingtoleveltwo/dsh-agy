import type { QuotaGroup } from './types.ts'

export function isGeminiQuotaGroup(group: QuotaGroup): boolean {
  return group.name.toLowerCase().includes('gemini')
    || group.windows.some((window) => window.bucketId.toLowerCase().startsWith('gemini-'))
}

export function filterGeminiQuotaGroups(groups: readonly QuotaGroup[] | null | undefined): QuotaGroup[] {
  return (groups ?? []).filter(isGeminiQuotaGroup)
}
