/**
 * The `ws` package, loaded at run time instead of bundled: Rollup's CommonJS transform turns ws's optional
 * `require('bufferutil')` into an empty object, and the first masked frame then crashes the server
 * ("bufferUtil.unmask is not a function"). Resolved from node_modules next to the bundle (also inside app.asar).
 */
import { createRequire } from 'node:module'
import type * as WsModule from 'ws'

const ws = createRequire(import.meta.url)('ws') as typeof WsModule

export const WebSocketServer = ws.WebSocketServer
export type WebSocketServer = WsModule.WebSocketServer
