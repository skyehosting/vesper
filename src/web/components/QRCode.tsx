/**
 * QRCode (04; pairing a phone — 07 A4/B16) — renders `value` as an SVG data URL in an <img>. The `qrcode` library is
 * loaded on first use (kept out of the initial bundle). Always dark-on-white with a quiet zone, whatever the theme,
 * because phone cameras need the contrast. Pairing codes are short-lived secrets: the value never goes into a URL
 * other than this data: image.
 *
 *   <QRCode value={pairUrl} label="Pairing code for your phone" size={220} />
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Skeleton } from './Skeleton'
import { cx } from './internal/cx'
import './QRCode.css'

export interface QRCodeProps {
  value: string
  /** Alt text: what scanning it does. */
  label: string
  size?: number
  /** Error correction (M by default; H survives a logo or a scuffed screen). */
  level?: 'L' | 'M' | 'Q' | 'H'
  className?: string
}

type QrModule = typeof import('qrcode')
let loader: Promise<QrModule> | null = null
const loadQr = (): Promise<QrModule> => (loader ??= import('qrcode').then((m) => ((m as { default?: QrModule }).default ?? m) as QrModule))

export function QRCode({ value, label, size = 200, level = 'M', className }: QRCodeProps): ReactNode {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    setFailed(false)
    loadQr()
      .then((qr) => qr.toString(value, { type: 'svg', errorCorrectionLevel: level, margin: 2, color: { dark: '#0b0b12', light: '#ffffff' } }))
      .then((svg) => {
        if (live) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
    }
  }, [value, level])

  return (
    <figure className={cx('qr', className)} style={{ width: size }}>
      <div className="qr__plate" style={{ width: size, height: size }}>
        {failed ? (
          <p className="qr__failed" role="alert">
            Couldn't draw the code. Use the link instead.
          </p>
        ) : src ? (
          <img src={src} alt={label} width={size - 16} height={size - 16} draggable={false} />
        ) : (
          <Skeleton variant="rect" width={size - 16} height={size - 16} />
        )}
      </div>
    </figure>
  )
}
