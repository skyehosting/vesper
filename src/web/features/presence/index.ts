/** Presence feature barrel — cross-feature exports with frozen signatures (07 E4). presence owns the bodies. */
export { Star, type StarProps } from './Star'
export { StarHost } from './StarHost'
/** A stage that fills its box (e.g. a phone header slot); registers with the one presence surface like <Star>. */
export { StarStage } from './StarStage'
/** Additive (v11 layout): the avatar behind the messages, an empty chat's hero slot, and the top bar's presence group. */
export { ChatBackdrop, AvatarAnchor, PresenceControls, useChatBackdrop } from './ChatBackdrop'
/** Additive (v1.1.3): Settings' live preview of the avatar behind a conversation (the one surface moves into it). */
export { AvatarPreview } from './AvatarPreview'
/** Additive (fix-presence-soak, second pass F51): Talk mode's entries check voice input first. */
export { openTalkMode } from './talk/entry'
export type { StarState } from '../../lib/store'
