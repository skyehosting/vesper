#!/usr/bin/env node
/**
 * Safe agent-worktree management (Windows).
 *   node scripts/worktree.mjs add <name>      → git worktree add ../vesper-wt/<name> -b agent/<name> + node_modules junction
 *   node scripts/worktree.mjs remove <name>   → unlink EVERY junction/symlink inside first (never following them),
 *                                               then git worktree remove, then delete the branch if merged.
 * Why: `git worktree remove --force` (and recursive deletes) FOLLOW the node_modules junction and wipe the main
 * repo's node_modules. Links must be unlinked before anything recursive touches the tree.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const wtRoot = path.resolve(repo, '..', 'vesper-wt')
const [cmd, name] = process.argv.slice(2)
if (!cmd || !name || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: node scripts/worktree.mjs add|remove <name>')
  process.exit(2)
}
const dir = path.join(wtRoot, name)
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim()

/** Unlink all links under `root` without following them. Returns how many were removed. */
function unlinkLinks(root) {
  let n = 0
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      let st
      try {
        st = fs.lstatSync(p)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) {
        // Junctions and directory symlinks: rmdir removes the link itself, never the target's contents.
        try {
          fs.rmdirSync(p)
        } catch {
          fs.unlinkSync(p)
        }
        n++
      } else if (st.isDirectory()) walk(p)
    }
  }
  walk(root)
  return n
}

function countLinks(root) {
  let n = 0
  const walk = (d) => {
    let entries
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) n++
      else if (st.isDirectory()) walk(p)
    }
  }
  walk(root)
  return n
}

if (cmd === 'add') {
  fs.mkdirSync(wtRoot, { recursive: true })
  git('worktree', 'add', dir, '-b', `agent/${name}`)
  fs.symlinkSync(path.join(repo, 'node_modules'), path.join(dir, 'node_modules'), 'junction')
  console.log(`worktree ready: ${dir} (branch agent/${name})`)
} else if (cmd === 'remove') {
  if (fs.existsSync(dir)) {
    const removed = unlinkLinks(dir)
    const left = countLinks(dir)
    if (left > 0) {
      console.error(`refusing to delete ${dir}: ${left} link(s) could not be unlinked`)
      process.exit(1)
    }
    try {
      git('worktree', 'remove', '--force', dir)
    } catch {
      fs.rmSync(dir, { recursive: true, force: true })
      git('worktree', 'prune')
    }
    console.log(`removed ${dir} (${removed} link(s) unlinked first)`)
  } else {
    git('worktree', 'prune')
  }
  try {
    git('branch', '-d', `agent/${name}`)
  } catch {
    console.log(`branch agent/${name} kept (not merged or missing)`)
  }
  if (!fs.existsSync(path.join(repo, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
    console.error('WARNING: main node_modules looks damaged — run npm ci && node node_modules/electron/install.js')
    process.exit(1)
  }
} else {
  console.error(`unknown command ${cmd}`)
  process.exit(2)
}
