/**
 * The app's slash-command registry (07 E1). Features register their commands from their own `commands.ts`; the fixed
 * list of those modules is lib/commands/index.ts. The composer calls `runCommand(text, ctx)` before sending.
 */
import type { api } from '../api'
import type { navigate } from '../router'
import type { WsClient } from '../ws.logic'
import type { toast } from '../../components/Toast'
import { createCommandRegistry, type CommandDef } from './registry.logic'

export interface CommandContext {
  /** The open session, if any. */
  sessionUid: string | null
  navigate: typeof navigate
  api: typeof api
  ws: WsClient
  toast: typeof toast
  /** Replace the composer text (e.g. a command that prepares a message). */
  setDraft(text: string): void
}

export type Command = CommandDef<CommandContext>

export const commands = createCommandRegistry<CommandContext>()

export function registerCommand(def: Command): () => void {
  return commands.register(def)
}

/** Run `text` as a command if it is a known one. Returns false when it should be sent as a normal message. */
export async function runCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const hit = commands.resolve(text)
  if (!hit) return false
  if (hit.def.available && !hit.def.available(ctx)) return false
  await hit.def.run({ ...ctx, command: hit.command })
  return true
}

export { parseCommand, splitArgs, unescapeSlash, type ParsedCommand } from './registry.logic'
