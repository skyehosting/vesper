/** The contract between tests/mocks/server.ts and each provider module (one file per owner, 07 E1). */
import type { ServerResponse } from 'node:http'
import type { MockRequest } from './http'

export interface MockModule {
  /** Recorded as `RecordedRequest.module`; also the path prefix that forces this module (`/<prefix>/v1/...`). */
  readonly name: string
  readonly prefixes: readonly string[]
  /** Answer the request and return true, or return false to let the next module try. */
  handle(req: MockRequest, res: ServerResponse): boolean | Promise<boolean>
  /** Drop queued scripts and modes (between tests). */
  reset(): void
}
