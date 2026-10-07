/**
 * Settings sections registry (07 D12 order, 07 E1). Each entry's page is owned by its domain agent and code-split;
 * settings-wizard owns the shell (SettingsPage) and the general/providers/chat/appearance/performance/about pages.
 * Section ids match ErrorAction `{kind:'settings', section}` in shared/errors.ts.
 */
import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Brain, Cpu, Database, Gauge, Info, KeyRound, MessageSquare, Mic, Palette, Shield, SlidersHorizontal, Volume2 } from 'lucide-react'

export interface SettingsSectionProps {
  /** Show the section's "Advanced" part (07 D12): the shell sets it when a search hit lives there. */
  advanced?: boolean
}

export interface SettingsSection {
  id: string
  title: string
  /** One line under the title in the phone list (and the page's subtitle). */
  description: string
  icon: LucideIcon
  order: number
  /** Only the desktop window may change it (remote clients see it read-only; the page's ReadOnlyNotice says so). */
  desktopOnly?: boolean
  load: () => Promise<{ default: ComponentType<SettingsSectionProps> }>
}

export const settingsSections: SettingsSection[] = [
  { id: 'general', title: 'General', description: 'Names, time zone and how Vesper runs on this PC', icon: SlidersHorizontal, order: 10, load: () => import('./pages/General') },
  { id: 'providers', title: 'AI providers', description: 'Services, keys and models', icon: Cpu, order: 20, desktopOnly: true, load: () => import('./pages/Providers') },
  { id: 'chat', title: 'Chat', description: 'History, sending, titles and notifications', icon: MessageSquare, order: 30, load: () => import('./pages/Chat') },
  { id: 'memory', title: 'Memory', description: 'Voyage, recall, pinned facts and protocols', icon: Brain, order: 40, load: () => import('../memory/SettingsMemory') },
  { id: 'voice-out', title: 'Voice out', description: 'Spoken replies, voices and tone', icon: Volume2, order: 50, load: () => import('../voice/SettingsVoiceOut') },
  { id: 'voice-in', title: 'Voice in', description: 'Microphone and speech recognition', icon: Mic, order: 60, load: () => import('../voice/SettingsVoiceIn') },
  { id: 'appearance', title: 'Presence & appearance', description: 'Theme, accent and the Star', icon: Palette, order: 70, load: () => import('./pages/Appearance') },
  { id: 'access', title: 'Access & security', description: 'Other devices, password and pairing', icon: KeyRound, order: 80, load: () => import('../access/SettingsAccess') },
  { id: 'privacy', title: 'Privacy', description: 'What leaves this PC, and where it goes', icon: Shield, order: 90, load: () => import('../privacy/SettingsPrivacy') },
  { id: 'data', title: 'Data', description: 'Export, import, backups and folders', icon: Database, order: 100, load: () => import('./pages/Data') },
  { id: 'performance', title: 'Performance', description: 'Game mode and resource use', icon: Gauge, order: 110, load: () => import('./pages/Performance') },
  { id: 'about', title: 'About', description: 'Version, credits and licences', icon: Info, order: 120, load: () => import('./pages/About') }
].sort((a, b) => a.order - b.order)

export function settingsSection(id: string | undefined): SettingsSection | undefined {
  return settingsSections.find((s) => s.id === id)
}

export const SECTION_TITLES: Readonly<Record<string, string>> = Object.fromEntries(settingsSections.map((s) => [s.id, s.title]))
