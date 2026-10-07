#!/usr/bin/env node
/**
 * Run the built standalone server (07 E3): node out/main/server-node.js, environment passed through (VESPER_TEST,
 * VESPER_DATA_DIR, VESPER_PORT, …). Prints the server's `VESPER_READY <url>` line; Ctrl+C stops it cleanly.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const entry = path.join(root, 'out', 'main', 'server-node.js')
if (!fs.existsSync(entry)) {
  console.error(`serve: ${path.relative(root, entry)} is missing; run "npx electron-vite build" first`)
  process.exit(2)
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], { cwd: root, env: process.env, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })

let stopping = false
const stop = () => {
  if (stopping) return
  stopping = true
  // Windows has no SIGTERM delivery to children: disconnecting the IPC channel asks the server to close cleanly.
  if (child.connected) child.disconnect()
  setTimeout(() => child.kill(), 5000).unref()
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, stop)
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
