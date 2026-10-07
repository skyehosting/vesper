; Vesper NSIS hooks (electron-builder `nsis.include`).
;
; customUnInstall (07 B14, F74): before the app files are removed, run resources\uninstall-cleanup.ps1 (generated from
; src/server/net/uninstall.ts). It removes ONLY what is Vesper's: the Tailscale Serve/Funnel mapping the app recorded
; (%APPDATA%\Vesper\tailscale-mapping.json), and only while HTTPS 443 still proxies to that port; and the
; "Vesper (LAN)" firewall rule of this installation's Vesper.exe (one UAC prompt, only if the rule exists; skipped in a
; silent uninstall). Never on an update: the old version's uninstaller runs with --updated, and the new version keeps
; the mapping and the rule. The script always exits 0, so it can never block an uninstall.
!include "x64.nsh"

!macro customUnInstall
  ${ifNot} ${isUpdated}
    ${If} ${FileExists} "$INSTDIR\resources\uninstall-cleanup.ps1"
      DetailPrint "Removing Vesper's Tailscale mapping and firewall rule (if any)..."
      ; 64-bit PowerShell on 64-bit Windows (the uninstaller itself is a 32-bit process).
      ${If} ${RunningX64}
        ${DisableX64FSRedirection}
      ${EndIf}
      ${if} ${Silent}
        nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall-cleanup.ps1" -InstallDir "$INSTDIR" -Silent'
      ${else}
        nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\uninstall-cleanup.ps1" -InstallDir "$INSTDIR"'
      ${endif}
      Pop $0
      ${If} ${RunningX64}
        ${EnableX64FSRedirection}
      ${EndIf}
    ${EndIf}
  ${endIf}
!macroend
