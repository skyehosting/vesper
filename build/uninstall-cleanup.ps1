# Vesper uninstall cleanup (07 B14, F74). GENERATED from src/server/net/uninstall.ts by its unit test - do not edit.
# Run by the NSIS uninstaller (build/installer.nsh) before the app files are removed; never on an update.
# Removes only what is Vesper's: the Tailscale Serve/Funnel mapping recorded in <DataDir>\tailscale-mapping.json,
# and only while HTTPS 443 still proxies to exactly that 127.0.0.1 port; and the "Vesper (LAN)" inbound
# firewall rule of THIS installation's Vesper.exe (one UAC prompt, only when the rule exists, never when -Silent).
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$DataDir = (Join-Path $env:APPDATA 'Vesper'),
  [string]$Tailscale = '',
  [switch]$Silent
)
$ErrorActionPreference = 'SilentlyContinue'

function Find-Tailscale {
  if ($Tailscale) { return $Tailscale }
  foreach ($base in @($env:ProgramW6432, $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($base) { $p = Join-Path $base 'Tailscale\tailscale.exe'; if (Test-Path -LiteralPath $p) { return $p } }
  }
  $c = Get-Command 'tailscale' -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  return $null
}

function Invoke-Tailscale([string]$Exe, [string[]]$Arguments) {
  Write-Host ('tailscale ' + ($Arguments -join ' '))
  & $Exe @Arguments | Out-Null
  return $LASTEXITCODE
}

# 1. Tailscale: only the mapping Vesper recorded, only while it still points at that port.
$marker = Join-Path $DataDir 'tailscale-mapping.json'
if (Test-Path -LiteralPath $marker) {
  $port = 0
  try { $port = [int]((Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json).port) } catch { $port = 0 }
  $ts = Find-Tailscale
  if ($port -ge 1 -and $port -le 65535 -and $ts) {
    $raw = (& $ts serve status --json 2>$null) | Out-String
    $cfg = $null
    try { $cfg = $raw | ConvertFrom-Json } catch { $cfg = $null }
    $ours = $false
    $funnel = $false
    if ($cfg -and $cfg.Web) {
      foreach ($site in $cfg.Web.PSObject.Properties) {
        if ($site.Name -notmatch '^[A-Za-z0-9.-]+\.ts\.net:443$') { continue }
        $proxy = [string]$site.Value.Handlers.'/'.Proxy
        if ($proxy -match ('^http://(127\.0\.0\.1|localhost):' + $port + '/?$')) {
          $ours = $true
          if ($cfg.AllowFunnel -and $cfg.AllowFunnel.($site.Name) -eq $true) { $funnel = $true }
        }
      }
    }
    if ($ours) {
      $ok = $true
      if ($funnel -and (Invoke-Tailscale $ts @('funnel', '--https=443', 'off')) -ne 0) { $ok = $false }
      if ((Invoke-Tailscale $ts @('serve', '--https=443', 'off')) -ne 0) { $ok = $false }
      if ($ok) { Remove-Item -LiteralPath $marker -Force }
    } else {
      Write-Host 'Tailscale: no Vesper mapping in place; nothing changed.'
    }
  }
}

# 2. Firewall: the rule of this installation's Vesper.exe only.
$exe = Join-Path $InstallDir 'Vesper.exe'
if ($exe -notmatch '["%\r\n]') {
  $rules = @(Get-NetFirewallApplicationFilter -Program $exe | Get-NetFirewallRule | Where-Object { $_.DisplayName -eq 'Vesper (LAN)' -and [string]$_.Direction -eq 'Inbound' })
  if ($rules.Count -gt 0) {
    $line = 'netsh advfirewall firewall delete rule name="Vesper (LAN)" program="' + $exe + '" dir=in'
    if ($Silent) {
      Write-Host 'Firewall: Vesper rule left in place (a silent uninstall cannot ask for permission).'
    } else {
      Write-Host ('elevated: ' + $line)
      Start-Process -FilePath 'cmd.exe' -ArgumentList ('/d /c ' + $line) -Verb RunAs -WindowStyle Hidden -Wait
    }
  }
}
exit 0
