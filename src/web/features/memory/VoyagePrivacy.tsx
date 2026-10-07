/**
 * The Voyage AI privacy note (R21, 07 A1/B13; research 02 §3): memory is kept on this PC, what Voyage receives, the
 * default training licence, and the owner's "$5" belief corrected — a payment method (not a purchase) unlocks the
 * opt-out that an organization admin must switch; paying alone doesn't opt out; not retroactive; may void free tokens;
 * undo only via legal@voyageai.com. Facts and links come from src/shared/privacy.ts (one source of disclosures).
 * Used by Settings → Memory, the wizard's Memory step and Settings → Privacy.
 */
import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import { disclosure } from '@shared/privacy'
import { Disclosure } from '../../components/Disclosure'
import { ExternalLink, sourceLabel } from '../privacy/ExternalLink'
import { cx } from './cx'
import { FIVE_DOLLAR_POINTS, verifiedLabel, VOYAGE_LEGAL_EMAIL } from './voyagePrivacy.logic'

export { FIVE_DOLLAR_POINTS, verifiedLabel, VOYAGE_LEGAL_EMAIL }

export function VoyagePrivacy({ compact = false, className, headingLevel = 3 }: { compact?: boolean; className?: string; headingLevel?: 3 | 4 }): ReactNode {
  const d = disclosure('voyage')
  const H = `h${headingLevel}` as 'h3' | 'h4'
  const points = (
    <ul className="vp__points">
      {FIVE_DOLLAR_POINTS.map((p) => (
        <li key={p}>{p.includes(VOYAGE_LEGAL_EMAIL) ? <Mail text={p} /> : p}</li>
      ))}
    </ul>
  )
  return (
    <section className={cx('vp', className)} aria-label="Memory and Voyage AI privacy" data-testid="voyage-privacy">
      <div className="vp__head">
        <span className="vp__icon" aria-hidden="true">
          <ShieldCheck />
        </span>
        <H className="vp__title">Your memory stays on this PC</H>
      </div>
      <p className="vp__text">
        Vesper keeps your messages, the memory timeline, the list of chats and every search vector here, in your data folder. Voyage AI doesn’t hold your
        memory: it only turns text into numbers. When memory is on, Vesper sends it the text of each message, your memory searches and — when a search ranks
        results — up to 40 earlier messages.
      </p>
      <p className="vp__text vp__text--strong">
        By default, Voyage’s terms let it keep what it receives and use it to train its models. Private chats are never sent to Voyage.
      </p>
      {compact ? (
        <Disclosure summary="About the “$5” rule and opting out" className="vp__more">
          {points}
        </Disclosure>
      ) : (
        <div className="vp__box">
          <p className="vp__box-title">About the “$5” rule and opting out</p>
          {points}
        </div>
      )}
      {d ? (
        <p className="vp__links">
          {d.sources.map((s) => (
            <ExternalLink key={s} href={s}>
              {sourceLabel(s)}
            </ExternalLink>
          ))}
          <span className="vp__verified">Checked {verifiedLabel(d.verified)}</span>
        </p>
      ) : null}
    </section>
  )
}

function Mail({ text }: { text: string }): ReactNode {
  const [before, after] = text.split(VOYAGE_LEGAL_EMAIL)
  return (
    <>
      {before}
      <ExternalLink href={`mailto:${VOYAGE_LEGAL_EMAIL}`}>{VOYAGE_LEGAL_EMAIL}</ExternalLink>
      {after}
    </>
  )
}
