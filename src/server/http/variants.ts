/** Variants at a fork (‹ n/m ›) and switching between them (07 C3); also in temporary chats (07 B9, own store). */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { VesperError } from '@shared/errors'
import type { ServerContext } from '../services'
import { parse, route } from './route'
import { storedOrTemporaryOr404 } from './sessions'

const params = z.object({ uid: z.string().min(1).max(64), seq: z.coerce.number().int().min(1) })

export function register(app: FastifyInstance, ctx: ServerContext): void {
  route(app, 'GET /api/sessions/:uid/variants/:seq', (req) => {
    const p = parse(params, req.params)
    const { s, st } = storedOrTemporaryOr404(ctx, p.uid)
    return st.repos.branches.variants(s.id, p.seq)
  })

  route(app, 'POST /api/sessions/:uid/variants/:seq', (req) => {
    const p = parse(params, req.params)
    const { s, st } = storedOrTemporaryOr404(ctx, p.uid)
    const { branchId } = parse(z.object({ branchId: z.number().int().positive() }), req.body)
    // Switching the path under a streaming reply would detach it from its own turn.
    if (ctx.services.chat?.busy(s.uid)) throw new VesperError('session_busy')
    const r = st.repos.branches.select(s.id, p.seq, BigInt(branchId))
    if (r.changed.length && !st.temporary) ctx.services.memory?.onPathChanged(s.id)
    ctx.hub.emit(s.uid, { t: 'session.path_changed', sessionUid: s.uid, forkSeq: p.seq, lastSeq: r.lastSeq })
    return { lastSeq: r.lastSeq }
  })
}
