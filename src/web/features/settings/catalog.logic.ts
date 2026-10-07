/**
 * Every setting with a label, help text and the Settings section that shows it — the index behind Settings search
 * (07 D12) and the reviewed list the coverage tests check against the zod schema. Pages show their own labels; these
 * are the words search matches. Paths use `[]` for array items (llm.profiles[].baseUrl).
 *
 * INTERNAL leaves are written by Vesper itself, never by a control (reviewed allow-list for the coverage test).
 */

export interface CatalogEntry {
  path: string
  section: string
  label: string
  help?: string
  /** Lives under the page's "Advanced" disclosure. */
  advanced?: boolean
  keywords?: string[]
}

/**
 * The keep-in-tray switch's one name (fix5-ui P29): Settings → General, the wizard's Look step, Settings → Access
 * (This PC card and the "Closing the window quits Vesper" callout) and the wizard's Access step all read it.
 */
export const CLOSE_TO_TRAY_LABEL = 'Keep running in the tray when closed'

/** Leaves no control edits (reviewed): Vesper writes them. */
export const INTERNAL_LEAVES: Readonly<Record<string, string>> = {
  version: 'schema version, set by migrations',
  'llm.profiles[].id': 'generated when a profile is added',
  'llm.profiles[].adapter': 'follows the chosen preset',
  'privacy.acknowledged': 'written when a privacy notice is acknowledged (wizard, Privacy page)',
  'wizard.completed': 'set by the wizard finale ("Run setup again" re-opens it)',
  'wizard.step': 'the wizard saves its position per step',
  'wizard.path': 'Quick start or Guided, chosen on the Welcome step',
  'wizard.skipped': 'skipped wizard steps (feed the setup checklist)',
  'wizard.checklistDismissed': 'the setup checklist close button'
}

export const SETTINGS_CATALOG: readonly CatalogEntry[] = [
  // General
  { path: 'profile.userName', section: 'general', label: 'Your name', help: 'How Vesper addresses you.', keywords: ['name', 'me'] },
  { path: 'profile.assistantName', section: 'general', label: "Assistant's name", help: 'What the AI calls itself.', keywords: ['vesper', 'rename'] },
  { path: 'profile.timeZone', section: 'general', label: 'Time zone', help: 'Used for the time stamps the AI sees with every message.', keywords: ['timezone', 'clock', 'date'] },
  { path: 'profile.clock', section: 'general', label: 'Clock', help: '24-hour or 12-hour times.', keywords: ['12h', '24h', 'am', 'pm', 'time format'] },
  { path: 'desktop.closeToTray', section: 'general', label: CLOSE_TO_TRAY_LABEL, help: 'Closing the window keeps Vesper reachable from your other devices.', keywords: ['tray', 'background', 'minimize'] },
  { path: 'desktop.startWithWindows', section: 'general', label: 'Start with Windows', help: 'Starts quietly in the tray when you sign in.', keywords: ['autostart', 'login', 'boot'] },
  { path: 'desktop.startInBackground', section: 'general', label: 'Start in the background', help: 'Open only the tray icon at start.', advanced: true, keywords: ['tray', 'hidden'] },

  // AI providers
  { path: 'llm.profiles[].label', section: 'providers', label: 'Profile name', keywords: ['provider', 'profile'] },
  { path: 'llm.profiles[].preset', section: 'providers', label: 'AI service', help: 'OpenAI, Anthropic, OpenRouter, Ollama, LM Studio or any OpenAI-compatible address.', keywords: ['provider', 'openai', 'anthropic', 'claude', 'gemini', 'openrouter', 'ollama', 'lm studio', 'groq', 'mistral', 'deepseek'] },
  { path: 'llm.profiles[].baseUrl', section: 'providers', label: 'Address (base URL)', help: 'https:// unless the service runs on this PC.', keywords: ['url', 'endpoint', 'api'] },
  { path: 'llm.profiles[].model', section: 'providers', label: 'Model', keywords: ['gpt', 'claude', 'llama'] },
  { path: 'llm.profiles[].authHeader', section: 'providers', label: 'Custom header name', help: 'For gateways that want the key in another header.', advanced: true, keywords: ['header', 'auth', 'proxy'] },
  { path: 'llm.profiles[].options.maxTokens', section: 'providers', label: 'Longest reply (tokens)', advanced: true, keywords: ['max tokens', 'length'] },
  { path: 'llm.profiles[].options.temperature', section: 'providers', label: 'Temperature', help: 'Higher is more varied, lower is more focused.', advanced: true, keywords: ['creativity', 'randomness'] },
  { path: 'llm.profiles[].options.effort', section: 'providers', label: 'Thinking effort', advanced: true, keywords: ['reasoning', 'thinking'] },
  { path: 'llm.profiles[].options.reasoningDisplay', section: 'providers', label: 'Show the model’s thinking', advanced: true, keywords: ['reasoning', 'summary'] },
  { path: 'llm.profiles[].options.openrouterNoTraining', section: 'providers', label: 'Only providers that don’t train on prompts', help: 'OpenRouter skips hosts that train on what you send.', keywords: ['privacy', 'openrouter', 'data collection'] },
  { path: 'llm.profiles[].options.openrouterZdr', section: 'providers', label: 'Zero-retention providers only', help: 'Many free models then stop working.', keywords: ['privacy', 'openrouter', 'zdr', 'retention'] },
  { path: 'llm.profiles[].capabilities.tools', section: 'providers', label: 'Model can use tools', help: 'Memory search works natively with tools; otherwise in text.', advanced: true, keywords: ['functions', 'tools'] },
  { path: 'llm.profiles[].capabilities.vision', section: 'providers', label: 'Model can see images', advanced: true, keywords: ['vision', 'images'] },
  { path: 'llm.profiles[].capabilities.pdf', section: 'providers', label: 'Model reads PDFs', advanced: true, keywords: ['pdf', 'documents'] },
  { path: 'llm.profiles[].capabilities.contextWindow', section: 'providers', label: 'Context window (tokens)', advanced: true, keywords: ['context', 'length'] },
  { path: 'llm.defaultProfile', section: 'providers', label: 'Default AI', help: 'New chats use this profile.', keywords: ['default', 'main'] },
  { path: 'llm.utilityProfile', section: 'providers', label: 'Helper AI for titles and summaries', help: 'A cheaper model for chat titles, recaps and summaries. Chats on a model on this PC use their own model for these, so their text stays on this PC.', keywords: ['utility', 'titles', 'recaps', 'summaries'] },
  { path: 'llm.utilityModel', section: 'providers', label: 'Helper model', keywords: ['utility', 'cheap'] },

  // Chat
  { path: 'chat.pageSize', section: 'chat', label: 'Messages per page', help: 'Vesper keeps about 3 pages in view and unloads the rest as you scroll.', keywords: ['history', 'window', 'load', 'scroll', 'page size', 'paging'] },
  { path: 'chat.sendOnEnter', section: 'chat', label: 'Enter sends', help: 'Shift+Enter makes a new line.', keywords: ['keyboard', 'enter', 'newline'] },
  { path: 'chat.autoTitle', section: 'chat', label: 'Name chats automatically', keywords: ['title', 'rename'] },
  { path: 'chat.showReasoning', section: 'chat', label: 'Show thinking', help: 'Show the model’s reasoning above its reply when it shares it.', keywords: ['reasoning', 'thinking'] },
  { path: 'chat.contextFill', section: 'chat', label: 'Summarize earlier messages at', help: 'When the conversation fills this much of the model’s context, Vesper writes a recap in the background.', advanced: true, keywords: ['recap', 'summary', 'context', 'condense'] },
  { path: 'chat.maxToolCalls', section: 'chat', label: 'Memory lookups per reply', advanced: true, keywords: ['tools', 'memory search'] },
  { path: 'chat.attachments.maxFileMb', section: 'chat', label: 'Largest attachment', advanced: true, keywords: ['file size', 'upload'] },
  { path: 'chat.attachments.maxTextChars', section: 'chat', label: 'Text read from a document', advanced: true, keywords: ['pdf', 'docx', 'characters'] },
  { path: 'chat.notifyWhenHidden', section: 'chat', label: 'Notify when a reply finishes in the background', keywords: ['notification'] },
  { path: 'chat.notificationPreviews', section: 'chat', label: 'Show message text in notifications', keywords: ['notification', 'preview', 'privacy'] },
  { path: 'chat.announceReplies', section: 'chat', label: 'Screen reader: announce replies', advanced: true, keywords: ['accessibility', 'screen reader', 'aria'] },
  { path: 'chat.loadRemoteImages', section: 'chat', label: 'Images from the web', help: 'Ask before loading an image from another site.', keywords: ['images', 'privacy', 'remote'] },

  // Presence & appearance
  { path: 'appearance.theme', section: 'appearance', label: 'Theme', keywords: ['dark', 'light', 'system', 'mode'] },
  { path: 'appearance.accent', section: 'appearance', label: 'Accent color', keywords: ['color', 'gold', 'violet', 'rose', 'aurora', 'ice'] },
  { path: 'appearance.reduceMotion', section: 'appearance', label: 'Reduce motion', keywords: ['animation', 'accessibility', 'motion'] },
  { path: 'chat.fontSize', section: 'appearance', label: 'Message text size', keywords: ['font', 'size', 'zoom'] },
  { path: 'appearance.star.style', section: 'appearance', label: 'Star style', help: 'Armilla (the default), orb, nebula, a flat 2D star, or off.', keywords: ['3d', 'presence', 'avatar', 'armilla', 'orb', 'nebula'] },
  { path: 'appearance.star.quality', section: 'appearance', label: 'Star quality', advanced: true, keywords: ['gpu', 'graphics'] },
  { path: 'appearance.star.maxFps', section: 'appearance', label: 'Star frame-rate limit', advanced: true, keywords: ['fps', 'gpu', 'battery'] },
  { path: 'appearance.star.pauseWhenUnfocused', section: 'appearance', label: 'Rest the Star when Vesper isn’t focused', keywords: ['pause', 'gpu', 'battery'] },
  { path: 'appearance.star.showInChat', section: 'appearance', label: 'Show the avatar behind the chat', keywords: ['stage', 'presence', 'backdrop', 'avatar'] },
  { path: 'appearance.star.visibility', section: 'appearance', label: 'Avatar visibility', help: 'How strongly the avatar shows behind your messages.', keywords: ['transparency', 'opacity', 'brightness', 'visible', 'avatar', 'armilla'] },
  { path: 'appearance.star.size', section: 'appearance', label: 'Avatar size', keywords: ['bigger', 'smaller', 'scale', 'avatar', 'armilla'] },

  // Performance
  { path: 'performance.gameMode', section: 'performance', label: 'Game mode', help: 'While a full-screen game runs, the Star rests, voice models unload and memory indexing pauses.', keywords: ['games', 'fullscreen', 'gpu', 'cpu'] },
  { path: 'desktop.keepWindowWarmSec', section: 'performance', label: 'Keep the closed window ready for', help: 'Reopening is instant within this time; afterwards the window’s memory is freed.', advanced: true, keywords: ['memory', 'tray', 'ram'] },

  // Memory (memory-ui's page)
  { path: 'memory.enabled', section: 'memory', label: 'Memory', help: 'Search earlier conversations with Voyage AI.', keywords: ['voyage', 'recall', 'remember'] },
  { path: 'memory.scopeDefault', section: 'memory', label: 'What a chat may remember', keywords: ['scope', 'linked', 'all sessions'] },
  { path: 'memory.autoRecall', section: 'memory', label: 'Recall automatically', keywords: ['auto recall'] },
  { path: 'memory.autoRecallMinScore', section: 'memory', label: 'Auto-recall threshold', advanced: true },
  { path: 'memory.searchMinScore', section: 'memory', label: 'Search threshold', advanced: true },
  { path: 'memory.maxRecallRounds', section: 'memory', label: 'Rounds per recall', advanced: true },
  { path: 'memory.maxRecallTokens', section: 'memory', label: 'Recalled text budget', advanced: true },
  { path: 'memory.voyage.baseUrl', section: 'memory', label: 'Voyage address', advanced: true, keywords: ['url', 'mongodb'] },
  { path: 'memory.voyage.embedModel', section: 'memory', label: 'Embedding model', keywords: ['voyage-4'] },
  { path: 'memory.voyage.rerankModel', section: 'memory', label: 'Rerank model', advanced: true },
  { path: 'memory.voyage.dim', section: 'memory', label: 'Vector size', advanced: true, keywords: ['dimensions'] },
  { path: 'memory.voyage.tier', section: 'memory', label: 'Voyage rate tier', advanced: true, keywords: ['free trial', 'limits'] },
  { path: 'memory.voyage.customEndpoint', section: 'memory', label: 'Custom Voyage endpoint', advanced: true },

  // Voice out (voice-client's page)
  { path: 'voice.tts.enabled', section: 'voice-out', label: 'Speak replies', keywords: ['tts', 'voice', 'speech'] },
  { path: 'voice.tts.provider', section: 'voice-out', label: 'Voice service', keywords: ['elevenlabs', 'openai', 'windows voices'] },
  { path: 'voice.tts.baseUrl', section: 'voice-out', label: 'Voice server address', advanced: true },
  { path: 'voice.tts.voiceId', section: 'voice-out', label: 'Voice' },
  { path: 'voice.tts.model', section: 'voice-out', label: 'Voice model' },
  { path: 'voice.tts.fastModelInTalk', section: 'voice-out', label: 'Fast voice in Talk mode' },
  { path: 'voice.tts.reveal', section: 'voice-out', label: 'Text appears with the voice', keywords: ['reveal', 'synced'] },
  { path: 'voice.tts.toneMode', section: 'voice-out', label: 'Voice tones', keywords: ['tone', 'tones', 'emotion', 'feeling', 'mood', 'follow the conversation', 'every reply'] },
  { path: 'voice.tts.tonePlacement', section: 'voice-out', label: 'Tone tag placement', advanced: true },
  { path: 'voice.tts.waitForTone', section: 'voice-out', label: 'Wait for the tone', advanced: true },
  { path: 'voice.tts.speed', section: 'voice-out', label: 'Speed' },
  { path: 'voice.tts.volume', section: 'voice-out', label: 'Volume' },
  { path: 'voice.tts.autoSpeak', section: 'voice-out', label: 'Speak automatically' },
  { path: 'voice.tts.perDevice', section: 'voice-out', label: 'Which devices speak', advanced: true },
  { path: 'voice.tts.speakCode', section: 'voice-out', label: 'Code blocks', advanced: true },
  { path: 'voice.tts.stability', section: 'voice-out', label: 'Stability', advanced: true },
  { path: 'voice.tts.similarity', section: 'voice-out', label: 'Similarity', advanced: true },
  { path: 'voice.tts.localUnloadAfterMin', section: 'performance', label: 'Unload the local voice after', advanced: true, keywords: ['memory', 'piper'] },

  // Voice in (voice-client's page)
  { path: 'voice.stt.enabled', section: 'voice-in', label: 'Voice input', keywords: ['microphone', 'stt', 'dictation'] },
  { path: 'voice.stt.provider', section: 'voice-in', label: 'Speech recognition' },
  { path: 'voice.stt.model', section: 'voice-in', label: 'Speech model', keywords: ['parakeet', 'moonshine', 'download'] },
  { path: 'voice.stt.mode', section: 'voice-in', label: 'Microphone mode', keywords: ['push to talk', 'dictate', 'conversation'] },
  { path: 'voice.stt.silenceMs', section: 'voice-in', label: 'Silence before sending', keywords: ['pause', 'timeout'] },
  { path: 'voice.stt.language', section: 'voice-in', label: 'Language' },
  { path: 'voice.stt.bargeIn', section: 'voice-in', label: 'Interrupting the AI', keywords: ['barge-in'] },
  { path: 'voice.stt.autoSendDictation', section: 'voice-in', label: 'Send dictation automatically' },
  { path: 'voice.stt.vadThreshold', section: 'voice-in', label: 'Speech detection sensitivity', advanced: true },
  { path: 'voice.stt.preRollMs', section: 'voice-in', label: 'Pre-roll', advanced: true },
  { path: 'voice.stt.maxUtteranceSec', section: 'voice-in', label: 'Longest utterance', advanced: true },
  { path: 'voice.stt.unloadAfterMin', section: 'performance', label: 'Unload the speech model after', help: 'Frees about 700 MB when the microphone isn’t used.', keywords: ['memory', 'ram', 'stt'] },
  { path: 'voice.stt.headphones', section: 'voice-in', label: 'I use headphones' },
  { path: 'voice.stt.earcons', section: 'voice-in', label: 'Listening sounds' },
  { path: 'voice.globalHotkey', section: 'voice-in', label: 'Push-to-talk hotkey', advanced: true, keywords: ['shortcut', 'keyboard'] },

  // Access & security (access-ui's page)
  { path: 'access.mode', section: 'access', label: 'Who can reach Vesper', keywords: ['lan', 'tailscale', 'remote', 'network', 'phone'] },
  { path: 'access.port', section: 'access', label: 'Port on this PC', advanced: true },
  { path: 'access.lanAddress', section: 'access', label: 'Network address', advanced: true },
  { path: 'access.lanPort', section: 'access', label: 'Local network port', advanced: true },
  { path: 'access.tailnetPort', section: 'access', label: 'Tailscale port', advanced: true },
  { path: 'access.funnel', section: 'access', label: 'Public access (Funnel)', keywords: ['internet', 'public'] },
  { path: 'access.funnelAutoOffHours', section: 'access', label: 'Turn public access off after', advanced: true },
  { path: 'access.keepRemoteWhileClosed', section: 'access', label: 'Keep remote access while closed' },
  { path: 'access.remoteMayChangeSettings', section: 'access', label: 'Other devices may change settings' },
  { path: 'access.idleTimeoutDays', section: 'access', label: 'Sign out idle devices after', advanced: true },

  // Data (memory-ui's page)
  { path: 'data.backups', section: 'data', label: 'Daily backups', keywords: ['backup', 'restore'] },
  { path: 'data.backupDaily', section: 'data', label: 'Daily backups to keep', advanced: true },
  { path: 'data.backupWeekly', section: 'data', label: 'Weekly backups to keep', advanced: true },
  { path: 'data.backupExtraDir', section: 'data', label: 'Extra backup folder', advanced: true },
  { path: 'data.diagnosticLogging', section: 'data', label: 'Diagnostic logging', advanced: true, keywords: ['logs', 'debug'] },

  // About (Updates, H-v12-updates)
  {
    path: 'updates.checkEvery',
    section: 'about',
    label: 'Check for updates',
    help: 'How often Vesper asks GitHub for a new version: every 5 or 15 minutes, hourly, daily, or off.',
    keywords: ['update', 'updates', 'upgrade', 'new version', 'release', 'github', 'auto-update']
  },
  {
    path: 'updates.mode',
    section: 'about',
    label: 'When a new version is out',
    help: 'Install it when you close Vesper, ask first, or restart by itself while you’re away.',
    keywords: ['update', 'updates', 'install', 'restart', 'download', 'automatic']
  }
]

export function catalogEntry(path: string): CatalogEntry | undefined {
  return SETTINGS_CATALOG.find((e) => e.path === path)
}

/** Normalised words for matching ("Time-zone" → "time zone"). */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export interface SearchHit {
  entry: CatalogEntry
  score: number
}

/**
 * Settings search: every query word must appear (as a word prefix) in the label, help, keywords, section title or
 * path. Label matches rank first.
 */
export function searchSettings(query: string, sectionTitles: Readonly<Record<string, string>>, limit = 12): SearchHit[] {
  const words = norm(query).split(' ').filter(Boolean)
  if (!words.length) return []
  const hits: SearchHit[] = []
  for (const entry of SETTINGS_CATALOG) {
    const label = ` ${norm(entry.label)}`
    const rest = ` ${norm([entry.help ?? '', ...(entry.keywords ?? []), sectionTitles[entry.section] ?? '', entry.path.replace(/[.[\]]/g, ' ')].join(' '))}`
    let score = 0
    let all = true
    for (const w of words) {
      if (label.includes(` ${w}`)) score += 3
      else if (rest.includes(` ${w}`)) score += 1
      else {
        all = false
        break
      }
    }
    if (all) hits.push({ entry, score: score - (entry.advanced ? 0.5 : 0) })
  }
  hits.sort((a, b) => b.score - a.score || a.entry.label.localeCompare(b.entry.label))
  return hits.slice(0, limit)
}
