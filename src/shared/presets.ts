/**
 * LLM provider presets for the wizard and Settings (research 01 §2.4, verified 2026-10-05). The llm-engine agent owns
 * the behaviour flags; privacy texts come from `privacy.ts` (research 08). Base URLs here are the defaults the user
 * can edit (custom preset = any URL); keys are bound to the origin they were saved for (07 B1).
 */
import type { PresetId } from './settings'

export interface Preset {
  id: PresetId
  label: string
  adapter: 'openai' | 'anthropic'
  baseUrl: string
  /** Auth header: Authorization: Bearer <key> unless stated. */
  auth: { header: string; scheme: 'Bearer' | '' }
  keyRequired: boolean
  /** Field name for the output cap. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens'
  sendStreamUsage: boolean
  imageMode: 'data-uri' | 'url-ok'
  pdfMode: 'native' | 'file-part' | 'extract-text'
  /** Mistral needs 9-char [a-zA-Z0-9] tool call ids. */
  toolCallIdRule?: 'mistral9'
  /** Which provider-opaque reasoning/extras must be echoed back (07 C7). */
  echoKey: string
  capabilitySource: 'anthropic-models' | 'openrouter-models' | 'ollama-show' | 'lmstudio-native' | 'mistral-models' | 'preset'
  defaults: { tools: boolean; vision: boolean }
  local: boolean
  docsUrl: string
  keyUrl?: string
  /** Suggested model id when /models cannot be read; never trusted over the live list. */
  exampleModel?: string
  notes?: string
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    adapter: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_completion_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'file-part',
    echoKey: 'openai',
    capabilitySource: 'preset',
    defaults: { tools: true, vision: true },
    local: false,
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    keyUrl: 'https://platform.openai.com/api-keys'
  },
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    adapter: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    auth: { header: 'x-api-key', scheme: '' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'native',
    echoKey: 'anthropic',
    capabilitySource: 'anthropic-models',
    defaults: { tools: true, vision: true },
    local: false,
    docsUrl: 'https://platform.claude.com/docs',
    keyUrl: 'https://platform.claude.com/settings/keys',
    exampleModel: 'claude-opus-5-5'
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    adapter: 'openai',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'gemini',
    capabilitySource: 'preset',
    defaults: { tools: true, vision: true },
    local: false,
    docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
    keyUrl: 'https://aistudio.google.com/apikey',
    notes: 'A 404 without a valid key means the key is wrong. Thought signatures are echoed automatically.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    adapter: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'file-part',
    echoKey: 'openrouter',
    capabilitySource: 'openrouter-models',
    defaults: { tools: true, vision: true },
    local: false,
    docsUrl: 'https://openrouter.ai/docs',
    keyUrl: 'https://openrouter.ai/keys'
  },
  {
    id: 'groq',
    label: 'Groq',
    adapter: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'groq',
    capabilitySource: 'preset',
    defaults: { tools: true, vision: false },
    local: false,
    docsUrl: 'https://console.groq.com/docs',
    keyUrl: 'https://console.groq.com/keys'
  },
  {
    id: 'mistral',
    label: 'Mistral',
    adapter: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    toolCallIdRule: 'mistral9',
    echoKey: 'mistral',
    capabilitySource: 'mistral-models',
    defaults: { tools: true, vision: true },
    local: false,
    docsUrl: 'https://docs.mistral.ai',
    keyUrl: 'https://console.mistral.ai/api-keys'
  },
  {
    id: 'xai',
    label: 'xAI (Grok)',
    adapter: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'xai',
    capabilitySource: 'preset',
    defaults: { tools: true, vision: true },
    local: false,
    docsUrl: 'https://docs.x.ai',
    keyUrl: 'https://console.x.ai'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    adapter: 'openai',
    baseUrl: 'https://api.deepseek.com',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'deepseek',
    capabilitySource: 'preset',
    defaults: { tools: true, vision: false },
    local: false,
    docsUrl: 'https://api-docs.deepseek.com',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    notes: 'Reasoning content is echoed back on every request that carries tools.'
  },
  {
    id: 'together',
    label: 'Together AI',
    adapter: 'openai',
    baseUrl: 'https://api.together.ai/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: true,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'together',
    capabilitySource: 'preset',
    defaults: { tools: true, vision: false },
    local: false,
    docsUrl: 'https://docs.together.ai',
    keyUrl: 'https://api.together.ai/settings/api-keys'
  },
  {
    id: 'ollama',
    label: 'Ollama (on this PC)',
    adapter: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: false,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'ollama',
    capabilitySource: 'ollama-show',
    defaults: { tools: true, vision: false },
    local: true,
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    notes: 'Raise the context size (num_ctx) in a Modelfile for long chats.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (on this PC)',
    adapter: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: false,
    maxTokensField: 'max_tokens',
    sendStreamUsage: true,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'lmstudio',
    capabilitySource: 'lmstudio-native',
    defaults: { tools: true, vision: false },
    local: true,
    docsUrl: 'https://lmstudio.ai/docs/app/api/endpoints/openai'
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible URL)',
    adapter: 'openai',
    baseUrl: '',
    auth: { header: 'Authorization', scheme: 'Bearer' },
    keyRequired: false,
    maxTokensField: 'max_tokens',
    sendStreamUsage: false,
    imageMode: 'data-uri',
    pdfMode: 'extract-text',
    echoKey: 'custom',
    capabilitySource: 'preset',
    defaults: { tools: false, vision: false },
    local: false,
    docsUrl: ''
  }
]

export function presetById(id: PresetId): Preset {
  const p = PRESETS.find((x) => x.id === id)
  if (!p) throw new Error(`unknown preset ${id}`)
  return p
}
