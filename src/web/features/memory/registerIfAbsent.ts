/**
 * Register a command unless its name (or an alias) is taken. chat-ui and sessions-ui register first
 * (lib/commands/index.ts imports sessions → chat → memory), and a duplicate registration would throw at startup, so
 * memory-ui's fallbacks (/prompt, /remember, …) step aside when another owner already provides them.
 */
import { commands, registerCommand, type Command } from '../../lib/commands/registry'

export function registerIfAbsent(def: Command): boolean {
  if ([def.name, ...(def.aliases ?? [])].some((n) => commands.get(n))) return false
  registerCommand(def)
  return true
}
