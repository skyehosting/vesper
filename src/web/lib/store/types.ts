/** The combined store type. Slices import it type-only, so there is no runtime cycle. */
import type { StateCreator } from 'zustand'
import type { AccessSlice } from './access'
import type { ChatSlice } from './chat'
import type { PresenceSlice } from './presence'
import type { SessionSlice } from './session'
import type { SettingsSlice } from './settings'
import type { UiSlice } from './ui'
import type { VoiceSlice } from './voice'

export type AppState = SessionSlice & ChatSlice & VoiceSlice & PresenceSlice & SettingsSlice & AccessSlice & UiSlice

/** Each slice file exports `createXSlice: SliceCreator<XSlice>`; store/index.ts combines them. */
export type SliceCreator<T> = StateCreator<AppState, [], [], T>
