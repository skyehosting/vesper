/**
 * The app store: zustand slices combined (07 E1). Each domain owns its slice file; this file only composes them.
 *
 *   const items = useStore((s) => s.sessions.items)
 *   useStore.getState().setPanelOpen(true)
 */
import { create } from 'zustand'
import { createAccessSlice } from './access'
import { createChatSlice } from './chat'
import { createPresenceSlice } from './presence'
import { createSessionSlice } from './session'
import { createSettingsSlice } from './settings'
import type { AppState } from './types'
import { createUiSlice } from './ui'
import { createVoiceSlice } from './voice'

export const useStore = create<AppState>()((...a) => ({
  ...createSessionSlice(...a),
  ...createChatSlice(...a),
  ...createVoiceSlice(...a),
  ...createPresenceSlice(...a),
  ...createSettingsSlice(...a),
  ...createAccessSlice(...a),
  ...createUiSlice(...a)
}))

export type { AppState, SliceCreator } from './types'
export type { AppPhase } from './access'
export type { StarState } from './presence'
export type { SttUiState, VoiceState } from './voice'
export type { ChatView, InflightView, ChatRow } from './chat.logic'
