/** `createRepos(db)`: the Repos interface (db/repos.ts) over the main connection. */
import type { Db } from '../sqlite'
import type { Repos } from '../repos'
import { createBranchesRepo, type BranchesExtra } from './branches'
import { createMessagesRepo } from './messages'
import { createSessionsRepo } from './sessions'
import { createAttachmentsRepo, createAuthLogRepo, createDevicesRepo, createEmbedQueueRepo, createFactsRepo, createKvRepo, createMemoryInjectionsRepo, createPromptsRepo } from './small'
import { createEpochsRepo, createTranscriptRepo } from './transcript'

/** Repos plus foundation-only helpers (not part of the frozen interface). */
export interface ReposImpl extends Repos {
  branches: Repos['branches'] & BranchesExtra
}

export function createRepos(db: Db): ReposImpl {
  return {
    sessions: createSessionsRepo(db),
    messages: createMessagesRepo(db),
    branches: createBranchesRepo(db),
    transcript: createTranscriptRepo(db),
    epochs: createEpochsRepo(db),
    prompts: createPromptsRepo(db),
    facts: createFactsRepo(db),
    attachments: createAttachmentsRepo(db),
    devices: createDevicesRepo(db),
    authLog: createAuthLogRepo(db),
    kv: createKvRepo(db),
    memoryInjections: createMemoryInjectionsRepo(db),
    embedQueue: createEmbedQueueRepo(db)
  }
}

export { sessionFromRow } from './sessions'
export { messageFromRow } from './messages'
