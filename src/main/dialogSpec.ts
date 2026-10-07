/** Native dialog descriptions (pure — unit-tested; shown by dialogs.ts). */

export interface DialogSpec {
  type: 'none' | 'info' | 'error' | 'question' | 'warning'
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  /** The answer for Esc / closing the box — and the automatic answer in test mode. */
  cancelId: number
}

/** The automatic answer for `spec`: `answer` as an index or a label (case-insensitive), else the cancel button. */
export function autoAnswer(spec: Pick<DialogSpec, 'buttons' | 'cancelId'>, answer: string | null | undefined): number {
  if (answer != null) {
    if (/^\d+$/.test(answer) && Number(answer) < spec.buttons.length) return Number(answer)
    const i = spec.buttons.findIndex((b) => b.toLowerCase() === answer.toLowerCase())
    if (i >= 0) return i
  }
  return spec.cancelId
}
