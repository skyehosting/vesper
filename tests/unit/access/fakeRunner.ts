/**
 * A CommandRunner that executes nothing and emulates the bits of `tailscale` and the firewall PowerShell probe that
 * access-server reads. Every command is recorded so tests can assert exactly what WOULD have run.
 */
import type { Command, CommandResult, CommandRunner } from '@server/net/runner'
import { decodePowerShell } from '@server/net/firewall'

export interface FakeTailscale {
  installed: boolean
  backendState: 'Running' | 'NeedsLogin' | 'Stopped'
  dnsName: string
  https: boolean
  /** Current serve config of HTTPS 443 (null = none). `foreignPort` emulates the owner's own Serve setting. */
  mapping: { port: number; funnel: boolean } | null
  /** Next mutating commands fail with this output (e.g. a consent URL). */
  failNext?: { stdout: string; stderr?: string }
}

export interface FakeFirewall {
  profiles: { alias: string; category: string }[]
  /** Inbound rules of Vesper's program, as the probe reports them. */
  rules: { name: string; action: string; enabled: string; profile: string; port?: string }[]
  /** Exit code of the elevated command (1 = UAC cancelled). */
  elevateCode: number
}

/** The netsh lines inside an elevated command (`cmd.exe /d /c a & b`). */
export function elevatedLines(cmd: Command): string[] {
  const m = /-ArgumentList '([\s\S]*?)' -Verb RunAs/.exec(decodePowerShell(cmd))
  if (!m) return []
  return m[1].replace(/''/g, "'").replace(/^\/d \/c /, '').split(' & ')
}

export class FakeRunner implements CommandRunner {
  readonly commands: Command[] = []
  closed = 0
  ts: FakeTailscale = { installed: true, backendState: 'Running', dnsName: 'vesper-pc.tail1234.ts.net', https: true, mapping: null }
  fw: FakeFirewall = { profiles: [{ alias: 'Ethernet', category: 'Public' }], rules: [], elevateCode: 0 }
  /** A successful elevated command applies its netsh lines to `fw.rules` (off: the rules stay as the test set them). */
  applyNetsh = false

  /** Commands of one kind, as "file arg arg" strings (tailscale exe shortened to `tailscale`). */
  lines(kind?: Command['kind']): string[] {
    return this.commands.filter((c) => !kind || c.kind === kind).map((c) => [c.file.endsWith('tailscale.exe') ? 'tailscale' : c.file, ...c.args].join(' '))
  }

  clear(): void {
    this.commands.length = 0
  }

  async run(cmd: Command): Promise<CommandResult> {
    this.commands.push(cmd)
    if (cmd.file === 'powershell.exe') {
      if (cmd.kind === 'elevate') {
        if (this.fw.elevateCode === 0 && this.applyNetsh) for (const line of elevatedLines(cmd)) this.netsh(line)
        return { code: this.fw.elevateCode, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: JSON.stringify({ profiles: this.fw.profiles, rules: this.fw.rules }), stderr: '' }
    }
    if (!/tailscale/.test(cmd.file)) return { code: null, stdout: '', stderr: '', error: 'ENOENT' }
    const t = this.ts
    if (!t.installed) return { code: null, stdout: '', stderr: '', error: 'ENOENT' }
    const a = cmd.args.join(' ')
    if (a === 'version') return { code: 0, stdout: '1.90.1\n  tailscale commit: abc\n', stderr: '' }
    if (a === 'status --json') {
      return {
        code: 0,
        stdout: JSON.stringify({ BackendState: t.backendState, Self: { DNSName: `${t.dnsName}.` }, CertDomains: t.https ? [t.dnsName] : null, CurrentTailnet: { MagicDNSSuffix: 'tail1234.ts.net' } }),
        stderr: ''
      }
    }
    if (a === 'serve status --json') {
      if (!t.mapping) return { code: 0, stdout: '{}\n', stderr: '' }
      const key = `${t.dnsName}:443`
      return {
        code: 0,
        stdout: JSON.stringify({ TCP: { 443: { HTTPS: true } }, Web: { [key]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${t.mapping.port}` } } } }, ...(t.mapping.funnel ? { AllowFunnel: { [key]: true } } : {}) }),
        stderr: ''
      }
    }
    if (cmd.kind === 'mutate') {
      if (t.failNext) {
        const f = t.failNext
        t.failNext = undefined
        return { code: 1, stdout: f.stdout, stderr: f.stderr ?? '' }
      }
      const on = /^(serve|funnel) --bg --https=443 http:\/\/127\.0\.0\.1:(\d+)$/.exec(a)
      if (on) t.mapping = { port: Number(on[2]), funnel: on[1] === 'funnel' }
      else if (a === 'serve --https=443 off' || a === 'funnel --https=443 off') t.mapping = null
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unknown command' }
  }

  /** Every fake rule belongs to Vesper's program, so `program=` filters always match. */
  private netsh(line: string): void {
    if (/ delete rule name=all program=".*" dir=in$/.test(line)) this.fw.rules = []
    else if (/ delete rule name="Vesper \(LAN\)"/.test(line)) this.fw.rules = this.fw.rules.filter((r) => r.name !== 'Vesper (LAN)')
    else {
      const add = /add rule name="Vesper \(LAN\)" .* localport=(\d+) .* profile=([a-z,]+) enable=yes$/.exec(line)
      if (add) {
        const profile = add[2]
          .split(',')
          .map((p) => p[0].toUpperCase() + p.slice(1))
          .join(', ')
        this.fw.rules.push({ name: 'Vesper (LAN)', action: 'Allow', enabled: 'True', profile, port: add[1] })
      }
    }
  }

  close(): void {
    this.closed++
  }
}

export { decodePowerShell }
