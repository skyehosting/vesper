/** Types of scripts/licenses.mjs (THIRD_PARTY_NOTICES.txt generator, 07 E7) for electron.vite.config.ts and tests. */
export interface NoticePackage {
  name: string
  version: string
  license: string
  repository: string | null
  texts: string[]
}
export const BUILD_ONLY: ReadonlySet<string>
export function collectPackages(root: string): NoticePackage[]
export function renderNotices(root: string): string
export function writeNotices(o: { root: string; outFiles: string[] }): Promise<number>
