/**
 * The standalone server (07 E3): `node out/main/server-node.js`. Plain Node — MUST NOT import electron. Used by the
 * browser e2e project (scripts/serve.mjs) and for headless runs. Prints `VESPER_READY <url>` once listening.
 */
import path from 'node:path'
import pkg from '../../package.json'
import { startServer } from './app'
import { recoverDamagedDatabase, StartupDbError, type DamagedDbChoice } from './data/backup'
import { MIGRATIONS } from './db/migrations'
import type { Log } from './services'
import { createNodePlatform } from './nodePlatform'
import { testEnv } from './testMode'

async function main(): Promise<void> {
  // Bundled to out/main/server-node.js → the app dir is out/.
  const appDir = path.resolve(__dirname, '..')
  const platform = createNodePlatform({ appDir, version: pkg.version })
  const portEnv = testEnv('VESPER_PORT')
  const start = () =>
    startServer(platform, {
      port: portEnv !== undefined ? Number(portEnv) : undefined,
      webDir: path.join(appDir, 'web'),
      workersDir: path.join(appDir, 'main'),
      devRendererUrl: null
    })
  let server: Awaited<ReturnType<typeof start>>
  try {
    server = await start()
  } catch (e) {
    // 07 C19 (F60): a damaged database — the owner chooses on the command line (the desktop app asks in a dialog).
    if (!(e instanceof StartupDbError && e.code === 'DB_CORRUPT')) throw e
    const choice = dbChoice(e, process.argv.slice(2))
    if (!choice) throw e
    const kept = recoverDamagedDatabase(e.details.dbFile, e.details.backupsDir, choice, { schemaVersion: Math.max(...MIGRATIONS.map((m) => m.version)), log: consoleLog })
    console.error(`Vesper server: the damaged database was moved to ${kept}.`)
    server = await start()
  }
  process.stdout.write(`VESPER_READY ${server.loopbackUrl}\n`)

  let stopping = false
  const stop = (signal: string) => {
    if (stopping) return
    stopping = true
    const force = setTimeout(() => process.exit(1), 5000)
    force.unref()
    server
      .close()
      .then(() => process.exit(0))
      .catch((e: unknown) => {
        console.error(`Vesper server: error while stopping on ${signal}:`, e instanceof Error ? e.message : e)
        process.exit(1)
      })
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => stop(sig))
  // A parent that talks over IPC (fork) can ask for a clean stop by disconnecting.
  process.on('disconnect', () => stop('disconnect'))
}

const consoleLog: Log = {
  debug: () => undefined,
  info: (m) => console.error(`Vesper server: ${m}`),
  warn: (m) => console.error(`Vesper server: ${m}`),
  error: (m) => console.error(`Vesper server: ${m}`),
  child: () => consoleLog
}

/** `--restore-backup[=<file>]` (default: the newest usable one) or `--start-fresh`; null when neither was given. */
function dbChoice(e: StartupDbError, argv: string[]): DamagedDbChoice | null {
  if (argv.includes('--start-fresh')) return { kind: 'fresh' }
  const arg = argv.find((a) => a === '--restore-backup' || a.startsWith('--restore-backup='))
  if (!arg) return null
  const file = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : e.details.backups?.[0]?.file
  return file ? { kind: 'restore', file } : null
}

main().catch((e: unknown) => {
  console.error('Vesper server failed to start:', e instanceof Error ? e.message : e)
  if (e instanceof StartupDbError && e.code === 'DB_DISK_FULL') console.error('The disk is full. Free up some space on the drive with the data folder, then start the server again.')
  if (e instanceof StartupDbError && e.code === 'DB_CORRUPT') {
    const list = e.details.backups ?? []
    console.error(
      [
        'Nothing has been changed. Choose one and start the server again:',
        list.length ? `  --restore-backup             restore the newest usable backup (${list[0].file})` : '  (there is no usable backup)',
        ...list.slice(1).map((b) => `  --restore-backup=${b.file}`),
        '  --start-fresh                start with an empty database',
        `The damaged files are kept either way (moved to a "damaged-…" folder in ${e.details.backupsDir}).`
      ].join('\n')
    )
  }
  process.exit(1)
})
