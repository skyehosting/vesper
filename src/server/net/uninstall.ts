/**
 * Uninstall cleanup (07 B14 "… and uninstall run `tailscale serve … off` / `funnel … off` for Vesper's mapping", F74).
 *
 * The NSIS uninstaller (build/installer.nsh, `customUnInstall`, never on an update) runs the PowerShell script that
 * `uninstallCleanupScript()` builds, shipped as `<install>\resources\uninstall-cleanup.ps1` (build/uninstall-cleanup.ps1,
 * generated from this file — a unit test keeps them identical). It removes ONLY what is Vesper's:
 *   - Tailscale: the mapping the app recorded in `<data>\tailscale-mapping.json` (written next to the kv record by the
 *     access manager), and only while HTTPS 443 on a *.ts.net name still proxies to exactly that 127.0.0.1 port —
 *     an owner's own Serve setting (another port) is never touched. Funnel off first, then Serve, as `transition`.
 *   - Firewall: the "Vesper (LAN)" inbound rule bound to THIS installation's Vesper.exe (a rule for another path, e.g. a
 *     second install, stays). Deleting a rule needs elevation: one UAC prompt, only when such a rule exists, never in a
 *     silent uninstall.
 * The uninstaller can't read SQLite, hence the small JSON marker. The app never runs this script.
 */
import fs from 'node:fs'
import path from 'node:path'
import { RULE_NAME } from './firewall'
import { psQuote } from './runner'
import { tsCommands } from './tailscale'

/** In the roaming data dir (%APPDATA%\Vesper): the Tailscale mapping Vesper set up, for the uninstaller. */
export const MAPPING_MARKER = 'tailscale-mapping.json'
/** The script's file name next to the app's other resources (electron-builder extraResources). */
export const UNINSTALL_SCRIPT = 'uninstall-cleanup.ps1'

/** Record (or forget) Vesper's mapping for the uninstaller. Best effort: never throws. */
export function writeMappingMarker(dataDir: string, mapping: { port: number; funnel: boolean } | null): void {
  const file = path.join(dataDir, MAPPING_MARKER)
  try {
    if (!mapping) {
      fs.rmSync(file, { force: true })
      return
    }
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ port: mapping.port, funnel: mapping.funnel }))
    fs.renameSync(tmp, file)
  } catch {
    /* the uninstaller then finds no marker and leaves Tailscale alone — the safe side */
  }
}

/** The netsh line that deletes Vesper's LAN rule for one executable (run elevated). */
export function firewallRemoveLine(program: string): string {
  if (/["\r\n%]/.test(program)) throw new Error('unsafe path for netsh')
  return `netsh advfirewall firewall delete rule name="${RULE_NAME}" program="${program}" dir=in`
}

const psArray = (args: string[]) => `@(${args.map(psQuote).join(', ')})`

/** PowerShell expression building firewallRemoveLine($exe) at run time (same template, so they can't drift). */
function psFirewallLine(): string {
  const [before, after] = firewallRemoveLine('@EXE@').split('@EXE@')
  return `${psQuote(before)} + $exe + ${psQuote(after)}`
}

/**
 * The cleanup script. ASCII only (Windows PowerShell 5.1 reads a BOM-less .ps1 in the ANSI code page) and LF line ends
 * (the repository normalises text files to LF; PowerShell accepts either).
 */

export function uninstallCleanupScript(): string {
  const funnelOff = tsCommands.funnelOff('').args
  const serveOff = tsCommands.serveOff('').args
  const serveStatus = tsCommands.serveStatus('').args
  return [
    '# Vesper uninstall cleanup (07 B14, F74). GENERATED from src/server/net/uninstall.ts by its unit test - do not edit.',
    '# Run by the NSIS uninstaller (build/installer.nsh) before the app files are removed; never on an update.',
    "# Removes only what is Vesper's: the Tailscale Serve/Funnel mapping recorded in <DataDir>\\" + MAPPING_MARKER + ',',
    '# and only while HTTPS 443 still proxies to exactly that 127.0.0.1 port; and the "' + RULE_NAME + '" inbound',
    "# firewall rule of THIS installation's Vesper.exe (one UAC prompt, only when the rule exists, never when -Silent).",
    'param(',
    '  [Parameter(Mandatory = $true)][string]$InstallDir,',
    "  [string]$DataDir = (Join-Path $env:APPDATA 'Vesper'),",
    "  [string]$Tailscale = '',",
    '  [switch]$Silent',
    ')',
    "$ErrorActionPreference = 'SilentlyContinue'",
    '',
    'function Find-Tailscale {',
    '  if ($Tailscale) { return $Tailscale }',
    '  foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {',
    "    if ($base) { $p = Join-Path $base 'Tailscale\\tailscale.exe'; if (Test-Path -LiteralPath $p) { return $p } }",
    '  }',
    "  $c = Get-Command 'tailscale' -ErrorAction SilentlyContinue",
    '  if ($c) { return $c.Source }',
    '  return $null',
    '}',
    '',
    'function Invoke-Tailscale([string]$Exe, [string[]]$Arguments) {',
    "  Write-Host ('tailscale ' + ($Arguments -join ' '))",
    '  & $Exe @Arguments | Out-Null',
    '  return $LASTEXITCODE',
    '}',
    '',
    '# 1. Tailscale: only the mapping Vesper recorded, only while it still points at that port.',
    `$marker = Join-Path $DataDir ${psQuote(MAPPING_MARKER)}`,
    'if (Test-Path -LiteralPath $marker) {',
    '  $port = 0',
    '  try { $port = [int]((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).port) } catch { $port = 0 }',
    '  $ts = Find-Tailscale',
    '  if ($port -ge 1 -and $port -le 65535 -and $ts) {',
    `    $raw = (& $ts ${serveStatus.join(' ')} 2>$null) | Out-String`,
    '    $cfg = $null',
    '    try { $cfg = $raw | ConvertFrom-Json } catch { $cfg = $null }',
    '    $ours = $false',
    '    $funnel = $false',
    '    if ($cfg -and $cfg.Web) {',
    '      foreach ($site in $cfg.Web.PSObject.Properties) {',
    "        if ($site.Name -notmatch '^[A-Za-z0-9.-]+\\.ts\\.net:443$') { continue }",
    "        $proxy = [string]$site.Value.Handlers.'/'.Proxy",
    "        if ($proxy -match ('^http://(127\\.0\\.0\\.1|localhost):' + $port + '/?$')) {",
    '          $ours = $true',
    '          if ($cfg.AllowFunnel -and $cfg.AllowFunnel.($site.Name) -eq $true) { $funnel = $true }',
    '        }',
    '      }',
    '    }',
    '    if ($ours) {',
    '      $ok = $true',
    `      if ($funnel -and (Invoke-Tailscale $ts ${psArray(funnelOff)}) -ne 0) { $ok = $false }`,
    `      if ((Invoke-Tailscale $ts ${psArray(serveOff)}) -ne 0) { $ok = $false }`,
    '      if ($ok) { Remove-Item -LiteralPath $marker -Force }',
    '    } else {',
    "      Write-Host 'Tailscale: no Vesper mapping in place; nothing changed.'",
    '    }',
    '  }',
    '}',
    '',
    "# 2. Firewall: the rule of this installation's Vesper.exe only.",
    "$exe = Join-Path $InstallDir 'Vesper.exe'",
    "if ($exe -notmatch '[\"%\\r\\n]') {",
    `  $rules = @(Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule | Where-Object { $_.DisplayName -eq ${psQuote(RULE_NAME)} -and [string]$_.Direction -eq 'Inbound' })`,
    '  if ($rules.Count -gt 0) {',
    `    $line = ${psFirewallLine()}`,
    '    if ($Silent) {',
    "      Write-Host 'Firewall: Vesper rule left in place (a silent uninstall cannot ask for permission).'",
    '    } else {',
    "      Write-Host ('elevated: ' + $line)",
    "      Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /c ' + $line) -Verb RunAs -WindowStyle Hidden -Wait",
    '    }',
    '  }',
    '}',
    'exit 0',
    ''
  ].join('\n')
}
