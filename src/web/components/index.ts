/**
 * The component kit (04-DESIGN-SYSTEM, 07 D8–D10/D13). The six primitives at the top keep frozen APIs (07 E4); the
 * rest is ui-kit's. Heavy parts load lazily inside their components (shiki in CodeBlock's worker, qrcode in QRCode),
 * so importing from here costs only the light shells.
 */
// Frozen primitives (07 E4)
export { Button, type ButtonProps, type ButtonVariant, type ButtonSize } from './Button'
export { IconButton, type IconButtonProps } from './IconButton'
export { Dialog, type DialogProps } from './Dialog'
export { toast, Toaster, type ToastOptions, type ToastTone, type ToastItem } from './Toast'
export { Tooltip, type TooltipProps, type TooltipSide } from './Tooltip'
export { Spinner, type SpinnerProps } from './Spinner'

// Forms
export { Field, useFieldIds, type FieldProps, type FieldIds } from './Field'
export { TextField, TextField as Input, type TextFieldProps } from './TextField'
export { TextArea, TextArea as Textarea, type TextAreaProps } from './TextArea'
export { Select, type SelectProps, type SelectOption } from './Select'
export { Combobox, type ComboboxProps } from './Combobox'
export { Switch, type SwitchProps } from './Switch'
export { Checkbox, type CheckboxProps } from './Checkbox'
export { RadioGroup, RadioGroup as RadioCards, type RadioGroupProps, type RadioOption } from './RadioGroup'
export { Segmented, type SegmentedProps, type SegmentedOption } from './Segmented'
export { Slider, type SliderProps, type SliderMark } from './Slider'
export { SecretInput, SecretInput as KeyField, cleanSecret, type SecretInputProps } from './SecretInput'
export { FileDrop, DropOverlay, useFileDrop, filesFromClipboard, type FileDropProps, type UseFileDropOptions, type Rejected } from './FileDrop'

// Navigation & overlays
export { Tabs, tabIds, tabPanelProps, type TabsProps, type TabItem } from './Tabs'
export { Menu, type MenuProps, type MenuItem } from './Menu'
export { ContextMenu, type ContextMenuProps } from './ContextMenu'
export { Popover, type PopoverProps } from './Popover'
export { Sheet, type SheetProps, type SheetSide } from './Sheet'
export { ConfirmDialog, useConfirm, type ConfirmDialogProps, type ConfirmOptions } from './ConfirmDialog'
export { Disclosure, Accordion, type DisclosureProps, type AccordionProps, type AccordionItem } from './Disclosure'

// Display
export { Card, type CardProps } from './Card'
export { Badge, Chip, LeavesPcBadge, type BadgeProps, type BadgeTone, type ChipProps } from './Badge'
export { RememberedChip, type RememberedChipProps, type RecalledItem } from './RememberedChip'
export { Avatar, initialsOf, type AvatarProps, type AvatarState } from './Avatar'
export { Kbd, type KbdProps } from './Kbd'
export { ProgressBar, ProgressRing, type ProgressBarProps, type ProgressRingProps, type ProgressTone } from './Progress'
export { Skeleton, type SkeletonProps } from './Skeleton'
export { StatusDot, type StatusDotProps, type Status } from './StatusDot'
export { EmptyState, type EmptyStateProps } from './EmptyState'
export { ErrorState, toApiError, type ErrorStateProps, type ErrorLike } from './ErrorState'
export { Callout, Banner, type CalloutProps, type BannerProps, type CalloutTone, type LearnMore } from './Callout'
export { CopyButton, type CopyButtonProps } from './CopyButton'
export { CodeBlock, type CodeBlockProps } from './CodeBlock'
export { QRCode, type QRCodeProps } from './QRCode'
export { List, ListItem, type ListProps, type ListItemProps } from './List'
export { VirtualList, type VirtualListProps, type VirtualListHandle, type Anchor, type Key, type ScrollAlign, type ScrollToOptions } from './VirtualList'

// Utilities other features use
export { copyText } from './internal/clipboard'
export { formatBytes } from './internal/files.logic'
export { formatSeconds } from './internal/slider.logic'
export { highlight, cachedHighlight, disposeHighlighter, highlighterStats } from './code/highlighter'
export { normalizeLang, langLabel } from './code/langs.logic'
export { kitStats } from './internal/stats'
