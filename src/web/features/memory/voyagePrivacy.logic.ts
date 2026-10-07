/** The Voyage privacy note's facts (07 A1), pure so tests can check every required point. */
export const VOYAGE_LEGAL_EMAIL = 'legal@voyageai.com'

/** The "$5" correction, point by point (unit-tested for each fact 07 A1 requires). */
export const FIVE_DOLLAR_POINTS: readonly string[] = [
  'There is no $5 minimum. The only $5 in Voyage’s terms is a liability cap.',
  'Adding a payment method — no purchase needed — is what makes the opt-out switch available. An organization admin then has to turn data use off in the Voyage dashboard (in MongoDB Atlas: “Help Improve Voyage AI Models”).',
  'Paying alone doesn’t opt you out: even paying accounts are opted in until that switch is turned off.',
  'Opting out only covers text sent afterwards. Earlier text stays under the default terms; text sent after opting out is deleted right after processing.',
  'Voyage may cancel your free tokens when you opt out.',
  `It can’t be undone in the dashboard — only by emailing ${VOYAGE_LEGAL_EMAIL}.`
]

/** "2026-10-05" → "5 Oct 2026". */
export function verifiedLabel(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${Number(m[3])} ${months[Number(m[2]) - 1]} ${m[1]}`
}
