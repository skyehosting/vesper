/**
 * The single source of privacy disclosures (07 B13; research 02 §3, 04 §1.7, 05 §1.8, 08). Consumed by the wizard
 * (just-in-time), Settings → Privacy, and "leaves this PC" badges. Acknowledgements are stored as `<id>@<version>`, so
 * changed wording is shown again. LLM provider entries are completed from research 08 (verified).
 */
import { isLoopbackUrl } from './loopback'

export { isLoopbackHost, isLoopbackUrl } from './loopback'

export interface Disclosure {
  id: string
  version: number
  service: string
  /** What leaves the PC when this feature is used. */
  sends: string
  /** Plain-language summary shown in the wizard (2–3 sentences). */
  summary: string
  training: 'no' | 'yes-by-default' | 'tier-dependent' | 'unknown' | 'local'
  retention: string
  optOutHow: string | null
  sources: string[]
  verified: string
}

export const DISCLOSURES: Disclosure[] = [
  {
    id: 'welcome',
    version: 1,
    service: 'Vesper',
    sends: 'Nothing by itself.',
    summary:
      'Your chats are stored on this PC. To answer, Vesper sends them to the AI service you choose; optional memory and voice services receive text too. Vesper itself has no accounts, no telemetry and no servers of its own.',
    training: 'local',
    retention: 'On this PC until you delete it.',
    optOutHow: null,
    sources: [],
    verified: '2026-10-05'
  },
  {
    id: 'voyage',
    version: 1,
    service: 'Voyage AI (MongoDB)',
    sends:
      'The text of each message (to turn it into searchable numbers), your search questions, and — when memory searches — up to 40 earlier messages so Voyage can rank them.',
    summary:
      "Voyage turns text into searchable numbers; your memories are kept on this PC, not by Voyage. Under Voyage's default terms, text you send may be used to train their models. To opt out you need a payment method on file and must switch off data use in your Voyage dashboard as an organization admin — paying alone does not opt you out, it only covers data sent afterwards, and undoing it requires emailing Voyage. (There is no $5 minimum; the $5 in their terms is a liability cap.)",
    training: 'yes-by-default',
    retention: 'Not stated for accounts that have not opted out; opted-out data is deleted right after processing.',
    optOutHow: 'Add a payment method, then as an organization admin turn off data use in the Voyage (or MongoDB Atlas) dashboard.',
    sources: ['https://www.voyageai.com/tos', 'https://docs.voyageai.com/docs/faq', 'https://www.mongodb.com/docs/voyageai/'],
    verified: '2026-10-05'
  },
  {
    id: 'elevenlabs',
    version: 1,
    service: 'ElevenLabs',
    sends: 'The text of replies to be spoken (and the tone hint).',
    summary:
      'ElevenLabs receives the text Vesper asks it to speak. It keeps request history and may use content to improve its services unless you opt out in your account\'s data-use settings; zero-retention mode is for Enterprise plans only.',
    training: 'yes-by-default',
    retention: 'Request history kept in your account; zero-retention only on Enterprise.',
    optOutHow: 'ElevenLabs account → Data use / privacy settings.',
    sources: ['https://elevenlabs.io/privacy-policy', 'https://elevenlabs.io/terms-of-use', 'https://elevenlabs.io/docs/eleven-api/resources/zero-retention-mode'],
    verified: '2026-10-05'
  },
  {
    id: 'openai-tts',
    version: 1,
    service: 'OpenAI text-to-speech',
    sends: 'The text of replies to be spoken.',
    summary: 'OpenAI receives the text to speak. API data is not used for training by default; abuse-monitoring logs may be kept for up to 30 days.',
    training: 'no',
    retention: 'Up to 30 days for abuse monitoring.',
    optOutHow: null,
    sources: ['https://openai.com/enterprise-privacy/', 'https://developers.openai.com/api/docs/guides/your-data'],
    verified: '2026-10-05'
  },
  {
    id: 'windows-voices',
    version: 1,
    service: 'Windows voices',
    sends: 'Nothing — speech is generated on this PC.',
    summary: 'Windows voices run entirely on this PC. Nothing is sent anywhere.',
    training: 'local',
    retention: 'None.',
    optOutHow: null,
    sources: [],
    verified: '2026-10-05'
  },
  {
    id: 'local-stt',
    version: 1,
    service: 'Speech recognition on this PC',
    sends: 'Nothing — your voice is transcribed on this PC.',
    summary: 'Your microphone audio is transcribed on this PC by an open-source model. Phones and other browsers send audio to your PC, not to the internet.',
    training: 'local',
    retention: 'Audio is not stored.',
    optOutHow: null,
    sources: [],
    verified: '2026-10-05'
  },
  {
    id: "llm.openai",
    version: 1,
    service: "OpenAI",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages and attachments to OpenAI to get each reply. OpenAI says it doesn't train on API data unless you opt in, but it keeps requests for up to 30 days to check for abuse, and authorized staff may review flagged content. Zero-retention is available only if OpenAI approves your organization.",
    training: "no",
    retention: "Up to 30 days for abuse monitoring.",
    optOutHow: "Zero-retention only with OpenAI approval.",
    sources: ["https://developers.openai.com/api/docs/guides/your-data","https://openai.com/enterprise-privacy/"],
    verified: '2026-10-05'
  },
  {
    id: "llm.anthropic",
    version: 1,
    service: "Anthropic",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages and attachments to Anthropic to get each reply. Under Anthropic's commercial terms it doesn't train on API data, and it deletes requests within 30 days (up to 2 years if its safety systems flag them for review). Zero-retention needs an agreement with Anthropic's sales team.",
    training: "no",
    retention: "Deleted within 30 days (up to 2 years if flagged by safety systems).",
    optOutHow: "Zero-retention by agreement with Anthropic sales.",
    sources: ["https://www.anthropic.com/legal/commercial-terms","https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data"],
    verified: '2026-10-05'
  },
  {
    id: "llm.gemini",
    version: 1,
    service: "Google Gemini",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages and attachments to Google, which keeps them 55 days for abuse checks. On the free tier (no billing on the key's Cloud project), Google may also use them to improve its products and human reviewers may read them, so don't share anything private. With billing on, or if you're in the EEA, UK or Switzerland, Google doesn't use them to improve its products.",
    training: "tier-dependent",
    retention: "55 days for abuse checks (all tiers).",
    optOutHow: "Enable billing on the key's Cloud project (free-tier data may be used to improve products).",
    sources: ["https://ai.google.dev/gemini-api/terms","https://ai.google.dev/gemini-api/docs/logs-policy"],
    verified: '2026-10-05'
  },
  {
    id: "llm.openrouter",
    version: 1,
    service: "OpenRouter",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages to OpenRouter, which passes them to the company that hosts the model you picked. OpenRouter doesn't store or train on your prompts unless you opt in, but some hosts may log them or train on them. With \"Only providers that don't train on prompts\" turned on (the default), Vesper asks OpenRouter to skip hosts that train. Hosts may still keep logs for a while unless you also turn on \"Zero-retention providers only\".",
    training: "tier-dependent",
    retention: "OpenRouter keeps none unless you opt in; the host it routes to may keep logs.",
    optOutHow: "Vesper asks OpenRouter to skip hosts that train (on by default); also turn on \"Zero-retention providers only\" to skip hosts that keep logs.",
    sources: ["https://openrouter.ai/docs/guides/privacy/data-collection","https://openrouter.ai/docs/guides/features/zdr"],
    verified: '2026-10-05'
  },
  {
    id: "llm.groq",
    version: 1,
    service: "Groq",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages to Groq. Groq says it doesn't train on them and doesn't keep them by default, except logs of up to 30 days when it investigates errors or abuse (stored in the US). You can switch on zero-retention yourself under Data Controls in the Groq console.",
    training: "no",
    retention: "Not kept by default; up to 30-day logs when investigating errors or abuse (US).",
    optOutHow: "Zero-retention under Data Controls in the Groq console.",
    sources: ["https://console.groq.com/docs/your-data"],
    verified: '2026-10-05'
  },
  {
    id: "llm.mistral",
    version: 1,
    service: "Mistral",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages to Mistral (hosted in the EU by default). Mistral may use API data to train its models unless you turn off \"Anonymous improvement data\" in the Admin panel under Privacy, and it keeps requests 30 days for abuse checks. \"Labs\" preview models may always be used for training.",
    training: "yes-by-default",
    retention: "30 days for abuse checks.",
    optOutHow: "Admin panel → Privacy → turn off \"Anonymous improvement data\".",
    sources: ["https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-artificial-intelligence-models", "https://legal.mistral.ai/terms/privacy-policy"],
    verified: '2026-10-05'
  },
  {
    id: "llm.xai",
    version: 1,
    service: "xAI (SpaceXAI)",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages to xAI (now SpaceXAI). It says it doesn't train on API data without your permission and keeps requests encrypted for 30 days for abuse audits. Where xAI offers it, a team admin can switch on zero-retention in the xAI Console.",
    training: "no",
    retention: "30 days, encrypted, for abuse audits.",
    optOutHow: "Where offered, a team admin can enable zero-retention in the xAI Console.",
    sources: ["https://x.ai/legal"],
    verified: '2026-10-05'
  },
  {
    id: "llm.deepseek",
    version: 1,
    service: "DeepSeek",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages to DeepSeek, which stores data in China. DeepSeek's privacy policy lets it use what you send to train its models (after de-identifying it), and keeps it as long as your account exists. There's no API switch to opt out; you can object by emailing privacy@deepseek.com.",
    training: "yes-by-default",
    retention: "Kept as long as your account exists; stored in China.",
    optOutHow: "No API switch; object by emailing privacy@deepseek.com.",
    sources: ["https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"],
    verified: '2026-10-05'
  },
  {
    id: "llm.together",
    version: 1,
    service: "Together AI",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages to Together AI. Together doesn't train on them unless you opt in, but by default it stores your prompts and replies to improve its service. To stop that, set \"Store prompts and model responses\" to No in Organization Settings → Privacy, which also blocks third-party \"passthrough\" models.",
    training: "no",
    retention: "Stores prompts and replies by default.",
    optOutHow: "Organization Settings → Privacy → \"Store prompts and model responses\" = No.",
    sources: ["https://docs.together.ai/docs/privacy"],
    verified: '2026-10-05'
  },
  {
    id: "llm.local",
    version: 1,
    service: "A model on this PC (Ollama / LM Studio)",
    sends: "Nothing leaves this PC.",
    summary: "This model runs on your own PC. Your messages don't leave this computer: Vesper talks to the model over a local connection, and the model's maker never sees them. Ollama and LM Studio may still check online for updates or model downloads.",
    training: "local",
    retention: "None.",
    optOutHow: null,
    sources: [],
    verified: '2026-10-05'
  },
  {
    id: "llm.local-custom",
    version: 1,
    service: "A program on this PC (custom address)",
    sends: "Nothing leaves this PC, unless that program forwards requests online.",
    summary: "This address is a program running on your own PC. Your messages don't leave this computer unless that program forwards requests online (some local tools pass them on to a cloud AI service): Vesper talks to it over a local connection.",
    training: "local",
    retention: "None, unless that program keeps or forwards them.",
    optOutHow: null,
    sources: [],
    verified: '2026-10-05'
  },
  {
    id: "llm.self-hosted",
    version: 1,
    service: "A model on another computer (Ollama / LM Studio)",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "This model doesn't run on this PC: its address points to another computer, so your messages, attachments and recalled memories travel there over the network. Vesper can't tell who runs that machine or what it keeps. If it's your own computer at home or on your tailnet, they stay with you; otherwise check its terms before sharing anything private.",
    training: "unknown",
    retention: "Depends on that computer.",
    optOutHow: null,
    sources: [],
    verified: '2026-10-05'
  },
  {
    id: "llm.ollama-cloud",
    version: 1,
    service: "Ollama cloud model",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "This is an Ollama cloud model: even though Vesper talks to Ollama on this PC, your messages are sent to Ollama's servers (which may process them in the US) to get the reply. Ollama says it processes them only for that request and doesn't train on them. To keep everything local, turn off Ollama's cloud features.",
    training: "no",
    retention: "Processed only for the request.",
    optOutHow: "Turn off Ollama cloud features (OLLAMA_NO_CLOUD=1).",
    sources: ["https://docs.ollama.com/cloud", "https://ollama.com/privacy"],
    verified: '2026-10-05'
  },
  {
    id: "llm.custom",
    version: 1,
    service: "Custom address",
    sends: "Your messages, attachments and recalled memories, plus requests for titles and summaries.",
    summary: "Vesper sends your messages and attachments to the address you entered. Vesper can't tell what this service does with them: whether it stores them, trains on them, or who can read them. Check its terms before sharing anything private. If it's a program running on this PC, nothing leaves your computer.",
    training: "unknown",
    retention: "Unknown.",
    optOutHow: null,
    sources: [],
    verified: '2026-10-05'
  },
  {
    id: "stt.openai",
    version: 1,
    service: "OpenAI speech recognition",
    sends: "Your voice messages (audio).",
    summary: "Each voice message is uploaded to OpenAI for transcription. OpenAI says it doesn't train on it or keep it in its abuse logs.",
    training: "no",
    retention: "Not kept in abuse logs.",
    optOutHow: null,
    sources: ["https://developers.openai.com/api/docs/guides/your-data"],
    verified: '2026-10-05'
  },
  {
    id: "stt.groq",
    version: 1,
    service: "Groq speech recognition",
    sends: "Your voice messages (audio).",
    summary: "Each voice message is uploaded to Groq for transcription. Groq doesn't train on it or keep it by default (except up to 30-day logs when investigating errors or abuse).",
    training: "no",
    retention: "Not kept by default (30-day logs when investigating).",
    optOutHow: null,
    sources: ["https://console.groq.com/docs/your-data"],
    verified: '2026-10-05'
  },
  {
    id: "stt.deepgram",
    version: 2,
    service: "Deepgram",
    sends: "Your voice messages (audio).",
    // Deepgram trains on audio by default, but Vesper opts out on every request (cloud.ts sends mip_opt_out=true),
    // so for Vesper's owner the answer is "not used for training" (fix5-ui P35).
    summary: "Each voice message is uploaded to Deepgram for transcription. Vesper always asks Deepgram not to keep or train on it (mip_opt_out).",
    training: "no",
    retention: "Vesper sends mip_opt_out=true so Deepgram keeps nothing.",
    optOutHow: "Vesper always sends mip_opt_out=true.",
    sources: ["https://developers.deepgram.com/docs/the-deepgram-model-improvement-partnership-program"],
    verified: '2026-10-05'
  },
  {
    id: "stt.elevenlabs",
    version: 1,
    service: "ElevenLabs speech recognition",
    sends: "Your voice messages (audio).",
    summary: "Each voice message is uploaded to ElevenLabs for transcription. ElevenLabs keeps data by default and may use it to improve its models unless you opt out under Data use.",
    training: "yes-by-default",
    retention: "Kept by default.",
    optOutHow: "ElevenLabs account → Data use.",
    sources: ["https://elevenlabs.io/privacy-policy"],
    verified: '2026-10-05'
  },
  {
    id: 'remote-access',
    version: 1,
    service: 'Access from other devices',
    sends: 'Your conversations travel between your PC and your other devices.',
    summary:
      'On your local network the connection is encrypted with a certificate made on this PC (your browser will warn once). With Tailscale, traffic stays inside your private Tailscale network; Tailscale publishes the machine name in public certificate logs. Funnel makes Vesper reachable from the whole internet — only with a strong password.',
    training: 'local',
    retention: 'None.',
    optOutHow: null,
    sources: ['https://tailscale.com/docs/how-to/set-up-https-certificates', 'https://tailscale.com/docs/features/tailscale-funnel'],
    verified: '2026-10-05'
  },
  {
    // H-v12-updates: the installed app's update checks (Settings → About → Updates). No text of yours is sent.
    id: 'updates',
    version: 1,
    service: 'Update checks (GitHub)',
    sends: "Your IP address and Vesper's version — no chats, settings or keys.",
    summary:
      "Update checks contact GitHub (github.com and its download servers): they see your IP address and Vesper's version. Turn checks off in Settings → About.",
    training: 'no',
    retention: "Server logs, under GitHub's privacy statement.",
    optOutHow: 'Settings → About → Check for updates → Off.',
    sources: [],
    verified: ''
  }
]

/**
 * Disclosure id for an LLM profile (research 08 §4). The address decides, not the preset (F19): Ollama or LM Studio at
 * a loopback address is §4.3a 'llm.local'; at any other address it's 'llm.self-hosted' (the messages travel to that
 * machine); a loopback custom address is §4.3a plus "unless that program forwards requests online"
 * ('llm.local-custom', §4.2's note). Ollama "…cloud" models go to ollama.com wherever Ollama runs.
 */
export function llmDisclosureId(preset: string, baseUrl: string, model?: string): string {
  if (preset === 'ollama' && model && /(^|[:-])cloud$/.test(model)) return 'llm.ollama-cloud'
  const loopback = isLoopbackUrl(baseUrl)
  if (preset === 'ollama' || preset === 'lmstudio') return loopback ? 'llm.local' : 'llm.self-hosted'
  if (preset === 'custom') return loopback ? 'llm.local-custom' : 'llm.custom'
  return `llm.${preset}`
}

/** Text sent to this AI profile stays on this PC (the 'local' entries above). */
export function llmStaysOnPc(id: string | null): boolean {
  return !!id && disclosure(id)?.training === 'local'
}

/**
 * The address is this PC but the program there may pass the text on ('llm.local-custom': a local proxy such as
 * LiteLLM in front of a cloud model, research 08 §4.2). Listed with what stays on this PC, but no absolute claim
 * ("Nothing leaves this PC", a green "On this PC") is made for it (F19).
 */
export function llmMayForward(id: string | null): boolean {
  return id === 'llm.local-custom'
}

/** Where an AI profile's text goes, for badges and chips: on this PC, on this PC unless it forwards, or away. */
export type LlmPlace = 'pc' | 'pc-may-forward' | 'leaves'

export function llmPlace(id: string | null): LlmPlace {
  if (!llmStaysOnPc(id)) return 'leaves'
  return llmMayForward(id) ? 'pc-may-forward' : 'pc'
}

/** Fallback for presets without a verified entry. */
export const UNKNOWN_PROVIDER: Pick<Disclosure, 'summary' | 'training'> = {
  summary: "Vesper can't tell what this service does with your messages. Check its terms before sending anything sensitive.",
  training: 'unknown'
}

export function disclosure(id: string): Disclosure | undefined {
  return DISCLOSURES.find((d) => d.id === id)
}


/** An OpenAI-compatible voice server on this PC (F20). */
const TTS_LOCAL_SERVER: Disclosure = {
  id: 'tts-local',
  version: 1,
  service: 'A voice server on this PC',
  sends: 'The text of replies to be spoken, to the server on this PC.',
  summary:
    "Your voice server runs on this PC, so the text it speaks stays on this computer — unless that server itself passes it on to another service. Check how it's set up if you're not sure.",
  training: 'local',
  retention: 'Up to your voice server.',
  optOutHow: null,
  sources: [],
  verified: ''
}

/** An OpenAI-compatible voice server anywhere else: Vesper can't know its terms (F20). */
const TTS_CUSTOM_SERVER: Disclosure = {
  id: 'tts-custom',
  version: 1,
  service: 'Custom voice service',
  sends: 'The text of replies to be spoken.',
  summary:
    "Vesper can't tell what this voice server does with the text it speaks: whether it keeps it, or trains on it. Check its terms before letting it read anything sensitive.",
  training: 'unknown',
  retention: 'Unknown.',
  optOutHow: null,
  sources: [],
  verified: ''
}

/**
 * The privacy text for a voice-out provider (07 B13, F20) — one answer for Voice settings, the wizard and Settings →
 * Privacy. An OpenAI-compatible server is never described with OpenAI's terms: on this PC it is local (unless it
 * forwards), anywhere else it is unknown.
 */
export function ttsDisclosure(provider: string, baseUrl: string): Disclosure {
  if (provider === 'elevenlabs') return disclosure('elevenlabs') as Disclosure
  if (provider === 'openai') return disclosure('openai-tts') as Disclosure
  if (provider === 'windows') return disclosure('windows-voices') as Disclosure
  if (provider === 'piper') return { ...(disclosure('windows-voices') as Disclosure), id: 'piper', service: 'Piper voices (on this PC)', summary: 'Piper voices run entirely on this PC. Nothing is sent anywhere.' }
  if (isLoopbackUrl(baseUrl)) return TTS_LOCAL_SERVER
  let host = ''
  try {
    host = new URL(baseUrl).host
  } catch {
    /* no address yet */
  }
  return host ? { ...TTS_CUSTOM_SERVER, service: host } : TTS_CUSTOM_SERVER
}

export function ackKey(d: Pick<Disclosure, 'id' | 'version'>): string {
  return `${d.id}@${d.version}`
}
