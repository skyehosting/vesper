/**
 * content-server (07 E1/E2): registers ctx.services.content — attachments + the extract process, the protocols file,
 * export/import/backup jobs and the daily maintenance tick (see ../../attachments/index.ts). No WS handlers: uploads
 * and data jobs are REST; progress goes out as `job.progress`, library changes as `prompts.changed`.
 */
import { contentOf } from '../../attachments'
import type { ServerContext } from '../../services'

export function register(ctx: ServerContext): void {
  ctx.services.content = contentOf(ctx)
}
