/**
 * The fixed list of feature command modules (07 E1, BLD-1 §5). Each owner fills its own file; nobody edits this list
 * except the orchestrator. Importing this module registers every command.
 */
import '../../features/sessions/commands'
import '../../features/chat/commands'
import '../../features/memory/commands'
import '../../features/voice/commands'
// presence: /talk, /constellation, /star (one line, recorded in docs/requests/presence.md)
import '../../features/presence/commands'

export { commands, registerCommand, runCommand, type Command, type CommandContext } from './registry'
