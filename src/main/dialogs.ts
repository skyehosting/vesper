/**
 * Native message boxes. In test mode, and while the dev-window marker keeps windows off the primary display, a dialog
 * is never shown (it would open on the primary display and take focus): it is printed as one `VESPER_DIALOG {json}`
 * line on stdout and answered with VESPER_DIALOG_ANSWER (a button index or label) or its cancel button.
 */
import { dialog, type BrowserWindow } from 'electron'
import { devWindowActive } from './devWindow'
import { autoAnswer, type DialogSpec } from './dialogSpec'
import { testEnv } from './env'

export type { DialogSpec }

/** Shows `spec` and resolves with the index of the chosen button. */
export async function ask(spec: DialogSpec, parent?: BrowserWindow | null): Promise<number> {
  const test = testEnv()
  if (__VESPER_TEST__ && (test || devWindowActive())) {
    const response = autoAnswer(spec, test?.dialogAnswer)
    process.stdout.write(`VESPER_DIALOG ${JSON.stringify({ ...spec, response })}\n`)
    return response
  }
  const opts = { ...spec, noLink: true }
  const r = parent && !parent.isDestroyed() ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts)
  return r.response
}
