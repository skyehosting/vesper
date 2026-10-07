/** Leak counters of the settings audio players (previews, samples): kept apart so test hooks don't load settings code. */
export const players = { players: 0, urls: 0 }

export function playerStats(): { players: number; urls: number } {
  return { ...players }
}
