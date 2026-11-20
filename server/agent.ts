import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

export type AgentDecision =
  | { kind: 'answer'; text: string }
  | { kind: 'action'; action: string; contacts: string[]; text: string; detail: string }

export type AgentContext = {
  text: string
  active?: { name: string; group: boolean } | null
  recent?: { from: string; text: string }[]
  contacts?: { name: string; group: boolean }[]
}

const ACTIONS = new Set([
  'open',
  'send',
  'reply',
  'create-group',
  'mute',
  'unmute',
  'archive',
  'unarchive',
  'pin',
  'unpin',
  'mark-read',
  'info',
  'close',
  'search',
])

let envLoaded = false

function loadEnv() {
  if (envLoaded) return
  envLoaded = true
  const path = fileURLToPath(new URL('../.env', import.meta.url))
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const cut = trimmed.indexOf('=')
    if (cut < 1) continue
    const key = trimmed.slice(0, cut).trim()
    const value = trimmed.slice(cut + 1).trim().replace(/^["']|["']$/g, '')
    if (!process.env[key]) process.env[key] = value
  }
}

function parseDecision(raw: string): AgentDecision | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let data: { kind?: string; text?: unknown; action?: string; contacts?: unknown; detail?: unknown }
  try {
    data = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  if (data.kind === 'answer') {
    const text = String(data.text || '').trim().slice(0, 500)
    return { kind: 'answer', text: text || 'Não posso ajudar com isso.' }
  }
  if (data.kind === 'action' && data.action && ACTIONS.has(data.action)) {
    const contacts = Array.isArray(data.contacts) ? data.contacts.map((item) => String(item)).filter(Boolean).slice(0, 8) : []
    return {
      kind: 'action',
      action: data.action,
      contacts,
      text: String(data.text || '').trim().slice(0, 500),
      detail: String(data.detail || '').trim().slice(0, 40),
    }
  }
  return null
}

async function endpoint() {
  loadEnv()
  const key = process.env.CHAT_API_KEY || process.env.GEMINI_API_KEY || ''
  const configured = process.env.CHAT_BASE_URL?.replace(/\/$/, '')
  if (key) {
    return {
      url: `${configured || 'https://generativelanguage.googleapis.com/v1beta/openai'}/chat/completions`,
      key,
      model: process.env.CHAT_MODEL || 'gemini-3.5-flash-lite',
    }
  }
  if (configured) {
    return { url: `${configured}/chat/completions`, key: '', model: process.env.CHAT_MODEL || 'llama3.2' }
  }
  try {
    const probe = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(800) })
    if (!probe.ok) return null
    const body = (await probe.json()) as { models?: { name?: string }[] }
    const model = process.env.CHAT_MODEL || body.models?.find((item) => item.name)?.name || ''
    if (!model) return null
    return { url: 'http://127.0.0.1:11434/v1/chat/completions', key: '', model }
  } catch {
    return null
  }
}

export async function decide(ctx: AgentContext): Promise<{ ok: true; decision: AgentDecision } | { ok: false; missing?: boolean; error: string }> {
  const target = await endpoint()
  if (!target) return { ok: false, missing: true, error: 'Sem modelo configurado' }
  const names = (ctx.contacts || []).slice(0, 80).map((item) => `${item.name}${item.group ? ' (grupo)' : ''}`)
  const recent = (ctx.recent || [])
    .slice(-6)
    .map((item) => `${item.from}: ${item.text}`)
    .join('\n')
  const system = [
    'Você lê o pedido do usuário e decide. Responda somente um JSON, sem texto fora dele.',
    'Pergunta: {"kind":"answer","text":"a resposta"}. Hora, data e conta simples são pergunta: use a data e a hora informadas e responda. Só use "Não posso ajudar com isso." quando não for WhatsApp, nem hora, data ou conta.',
    'Ação no WhatsApp: {"kind":"action","action":"...","contacts":["Nome"],"text":"...","detail":""}. Não diga que já fez a ação.',
    'Ações: open, send, reply, create-group, mute, unmute, archive, unarchive, pin, unpin, mark-read, info, close, search.',
    'create-group: text é o nome do grupo e contacts são as outras pessoas. O usuário já entra.',
    'send e reply: text é a mensagem. mute: detail é 8h, 1w ou forever. pin favorita a conversa.',
    'Use só nomes que estejam na lista.',
  ].join('\n')
  const now = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date())
  const user = [
    `Agora: ${now}.`,
    ctx.active ? `Conversa aberta: ${ctx.active.name}${ctx.active.group ? ' (grupo)' : ''}` : 'Nenhuma conversa aberta.',
    recent ? `Últimas mensagens:\n${recent}` : '',
    names.length ? `Contatos: ${names.join(', ')}` : '',
    `Pedido: ${ctx.text}`,
  ]
    .filter(Boolean)
    .join('\n\n')
  try {
    const content = await complete(target, system, user)
    const decision = parseDecision(content)
    if (!decision) return { ok: false, error: 'O modelo não devolveu uma decisão válida' }
    return { ok: true, decision }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'O modelo não respondeu'
    console.error('[zap] modelo', message)
    return { ok: false, error: message }
  }
}

function postJson(url: string, headers: Record<string, string>, body: string) {
  // Local models (Ollama at http://127.0.0.1:11434) speak plain HTTP; https.request would refuse them.
  const secure = new URL(url).protocol === 'https:'
  const send = secure ? https.request : http.request
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
        ...(secure ? { ca: tls.getCACertificates('system') } : {}),
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.setTimeout(45000, () => req.destroy(new Error('O modelo demorou demais')))
    req.on('error', reject)
    req.end(body)
  })
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function complete(target: { url: string; key: string; model: string }, system: string, user: string) {
  const gemini = target.key.startsWith('AQ.') || target.url.includes('generativelanguage.googleapis.com')
  const models = gemini ? [...new Set([target.model, 'gemini-3.5-flash-lite', 'gemini-3.6-flash'])] : [target.model]
  let last = 'O modelo não respondeu'
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = gemini
          ? await postJson(
              `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
              { 'content-type': 'application/json', 'x-goog-api-key': target.key },
              JSON.stringify({
                systemInstruction: { parts: [{ text: system }] },
                contents: [{ role: 'user', parts: [{ text: user }] }],
                generationConfig: {
                  temperature: 0,
                  ...(model.includes('flash-lite') ? {} : { thinkingConfig: { thinkingLevel: 'low' } }),
                },
              }),
            )
          : await postJson(
              target.url,
              { 'content-type': 'application/json', ...(target.key ? { authorization: `Bearer ${target.key}` } : {}) },
              JSON.stringify({
                model,
                temperature: 0,
                messages: [
                  { role: 'system', content: system },
                  { role: 'user', content: user },
                ],
              }),
            )
        const raw = response.text
        if (response.status === 429 || response.status === 503) {
          last = 'O modelo está cheio. Tente de novo em alguns segundos.'
          await sleep(1200)
          continue
        }
        if (response.status < 200 || response.status >= 300) {
          let detail = ''
          try {
            const parsed = JSON.parse(raw) as { error?: { message?: string } }
            detail = parsed.error?.message || ''
          } catch {
            detail = ''
          }
          const message = detail ? `O modelo recusou: ${detail.slice(0, 180)}` : 'O modelo não respondeu'
          if (/no longer available|not found|is not supported/i.test(detail)) {
            last = message
            break
          }
          throw new Error(message)
        }
        if (!gemini) {
          const body = JSON.parse(raw) as { choices?: { message?: { content?: string } }[] }
          return body.choices?.[0]?.message?.content || ''
        }
        const body = JSON.parse(raw) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
        return body.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || ''
      } catch (error) {
        const message = error instanceof Error ? error.message : 'O modelo não respondeu'
        if (message !== 'O modelo demorou demais') throw error
        last = message
      }
    }
  }
  throw new Error(last)
}
