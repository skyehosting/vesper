/**
 * "Open folder" for Settings → About, Privacy and Data: `POST /api/system/open-folder` (desktop only; the server
 * resolves a fixed set of folders and opens it in Explorer, 07 E8). Pages show the button only in the desktop
 * window. The standalone server has no shell to open folders with and answers 501 with its own sentence, which is
 * shown as is.
 */
import type { OpenFolderTarget } from '@shared/api'
import { toast } from '../../components/Toast'
import { api } from '../../lib/api'
import { toApiError } from '../../lib/errors.logic'

/** Open one of Vesper's folders on this PC; false (with a toast saying why) when it couldn't. */
export async function openFolder(which: OpenFolderTarget): Promise<boolean> {
  try {
    await api('POST /api/system/open-folder', { body: { which } })
    return true
  } catch (e) {
    const err = toApiError(e)
    toast.error(err.code === 'not_implemented' ? err.message || 'Opening folders needs the Vesper app on your PC.' : err.message, { title: "Couldn't open the folder" })
    return false
  }
}
