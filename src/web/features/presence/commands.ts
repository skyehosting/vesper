/**
 * Presence commands (01 "Commands"): /talk opens Talk mode for this chat, /constellation the memory map, /star pauses
 * or restyles the Star on this device (DevicePrefs, 07 D8 — the synced setting stays as it is).
 */
import { registerCommand } from '../../lib/commands/registry'
import { useStore } from '../../lib/store'
import type { StarStyle } from '../../lib/store/presence.logic'
import { openTalkMode } from './talk/entry'

registerCommand({
  name: 'talk',
  help: 'Talk with Vesper by voice (Talk mode)',
  available: (ctx) => ctx.sessionUid !== null,
  run: (ctx) => {
    if (ctx.sessionUid) openTalkMode(ctx.sessionUid)
  }
})

registerCommand({
  name: 'constellation',
  aliases: ['sky'],
  help: 'See your conversations as a constellation',
  run: (ctx) => ctx.navigate('/constellation')
})

const STYLES: Record<string, StarStyle> = { armilla: 'armilla', orb: 'orb', nebula: 'nebula', '2d': 'minimal2d', minimal: 'minimal2d', off: 'off' }

registerCommand({
  name: 'star',
  args: 'pause|resume|orb|nebula|2d|off|default',
  help: 'Pause the Star, or change its look on this device',
  run: (ctx) => {
    const arg = ctx.command.argv[0]?.toLowerCase() ?? ''
    const st = useStore.getState()
    if (arg === 'pause' || arg === 'resume' || arg === '') {
      const paused = arg === '' ? !st.presence.paused : arg === 'pause'
      st.setStarPaused(paused)
      ctx.toast.info(paused ? 'The Star is paused. /star resume brings it back.' : 'The Star moves again.')
      return
    }
    if (arg === 'default') {
      st.setPresencePrefs({ style: undefined })
      ctx.toast.info('The Star follows Settings again on this device.')
      return
    }
    const style = STYLES[arg]
    if (!style) {
      ctx.toast.warning('Try /star pause, /star resume, or a style: armilla, orb, nebula, 2d, off.')
      return
    }
    st.setPresencePrefs({ style })
    ctx.toast.info(style === 'off' ? 'The Star is off on this device.' : `The Star is now “${arg}” on this device.`)
  }
})
