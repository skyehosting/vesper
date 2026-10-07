/**
 * Downloadable model catalogue (07 B12): pinned URLs + SHA-256 + licence + attribution. Only GitHub release assets of
 * k2-fsa/sherpa-onnx or Hugging Face `resolve/<40-hex commit>` URLs. Digests come from the GitHub API (research 05
 * §3.1, independently verified); null digests are not allowed here (we pin our own when upstream has none).
 * Models are stored under %LOCALAPPDATA%\Vesper\models\<id>\ (07 E8).
 */
import type { ApiError } from './errors'

export type ModelKind = 'stt' | 'tts'

export interface ModelFile {
  url: string
  size: number
  sha256: string
  /** Archive format to extract with %SystemRoot%\System32\tar.exe (null = single file). */
  archive: 'tar.bz2' | null
}

export interface ModelEntry {
  id: string
  kind: ModelKind
  label: string
  description: string
  languages: string
  files: ModelFile[]
  unpackedSize: number
  /** Approximate resident memory when loaded. */
  ramMB: number
  license: string
  attribution: string
  /** sherpa-onnx model family (how stt.process builds the recognizer). */
  family: 'nemo-transducer' | 'moonshine' | 'sense-voice' | 'whisper'
  /** Directory name inside the archive. */
  dir: string
  recommended?: boolean
}

const GH = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/'

export const STT_MODELS: readonly ModelEntry[] = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    kind: 'stt',
    label: 'Parakeet TDT 0.6B v3 (recommended)',
    description: 'Best accuracy. 25 European languages with automatic detection, punctuation and capitals.',
    languages: '25 European languages',
    files: [{ url: `${GH}sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2`, size: 487_170_055, sha256: '5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf', archive: 'tar.bz2' }],
    unpackedSize: 671_239_000,
    ramMB: 725,
    license: 'CC-BY-4.0',
    attribution: 'NVIDIA Parakeet TDT 0.6B v3 by NVIDIA, licensed CC BY 4.0; ONNX conversion by the sherpa-onnx project.',
    family: 'nemo-transducer',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    recommended: true
  },
  {
    id: 'moonshine-base-en-2026-02-27',
    kind: 'stt',
    label: 'Moonshine base (light, English)',
    description: 'Small and fast. English only.',
    languages: 'English',
    files: [{ url: `${GH}sherpa-onnx-moonshine-base-en-quantized-2026-02-27.tar.bz2`, size: 111_266_225, sha256: '43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891', archive: 'tar.bz2' }],
    unpackedSize: 141_498_518,
    ramMB: 192,
    license: 'MIT',
    attribution: 'Moonshine by Useful Sensors, MIT licence; ONNX conversion by the sherpa-onnx project.',
    family: 'moonshine',
    dir: 'sherpa-onnx-moonshine-base-en-quantized-2026-02-27'
  },
  {
    id: 'sense-voice-2024-07-17-int8',
    kind: 'stt',
    label: 'SenseVoice (Chinese, Japanese, Korean, Cantonese, English)',
    description: 'For East Asian languages.',
    languages: 'zh, en, ja, ko, yue',
    files: [{ url: `${GH}sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2`, size: 163_002_883, sha256: '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e', archive: 'tar.bz2' }],
    unpackedSize: 240_506_435,
    ramMB: 300,
    license: 'Model licence of FunAudioLLM SenseVoice (see model card)',
    attribution: 'SenseVoice by FunAudioLLM / Alibaba; ONNX conversion by the sherpa-onnx project.',
    family: 'sense-voice',
    dir: 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
  }
]

/** Bundled with the app (resources/models), MIT. */
export const SILERO_VAD = {
  file: 'silero_vad.onnx',
  size: 643_854,
  sha256: '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6',
  license: 'MIT',
  attribution: 'Silero VAD by Silero Team, MIT licence.'
} as const

/** Hosts a model download may redirect to (07 B12). */
export const MODEL_DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'huggingface.co'] as const

export interface SttModelInfo {
  id: string
  label: string
  description: string
  languages: string
  downloadBytes: number
  ramMB: number
  license: string
  attribution: string
  state: 'not-installed' | 'downloading' | 'verifying' | 'extracting' | 'installed' | 'error'
  progress?: { bytes: number; total: number }
  recommended?: boolean
  active: boolean
  /** Bytes the installed model takes on disk (installed models only). */
  diskBytes?: number
  /** Why the last download or install failed (state 'error'). */
  error?: ApiError
}
