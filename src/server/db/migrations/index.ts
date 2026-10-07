/** Ordered migration list. Phase 2+ agents add theirs with their assigned number; the orchestrator orders them here. */
import type { Migration } from '../sqlite'
import { m001Init } from './001_init'
import { m003Memory } from './003_memory'
import { m004ContentServer } from './004_content_server'
import { m009SessionTokens } from './009_session_tokens'
import { m010MessageAttachments } from './010_message_attachments'

export const MIGRATIONS: readonly Migration[] = [m001Init, m003Memory, m004ContentServer, m009SessionTokens, m010MessageAttachments]
