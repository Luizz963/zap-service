// A fake WhatsApp for testing the app safely: same exports as ./whatsapp.ts, but everything
// lives in memory with invented people, groups and messages. Nothing touches your real
// WhatsApp account, login (wwebjs_auth) or chat cache (data/cache.json).
//
// Run with:  npm run dev:fake
//
// What it simulates:
//  - 8 people and 5 groups with history, unread chats, a poll, reactions, a quote, a photo, a document
//  - delivery ticks (sent → delivered → read), "digitando..." and automatic replies in 1:1 chats
//  - someone in a group reacts 👍 to what you send; group members vote on polls you create
//  - groups where you are NOT admin refuse changes (like the real WhatsApp)
//  - blocked contacts, leaving a group, "load earlier" (Bruno has a long history)
//  - a random person writes to you every 2 minutes (to test unread / notifications)
// Restarting the server resets everything.

import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import type {
  BlastProgress,
  ChatMessage,
  ChatProfile,
  CommonGroup,
  ConnectionState,
  Contact,
  LibraryItem,
  Participant,
  Poll,
} from './types.ts'
import type { CommandAction, CommandFile } from './whatsapp.ts'
import { colorFor, initials, isUsefulJid, renderTemplate, sleep } from './util.ts'
import { sameMessageId } from '../src/messageIds.ts'

export type { CommandAction, CommandFile }

export const waEvents = new EventEmitter()

const MIN = 60_000
const ME = { id: '5511900000000@c.us', name: 'Modo teste', initials: 'MT' }

type Person = { id: string; name: string; phone: string; about: string }
type GroupInfo = { members: string[]; admins: string[]; description: string; left?: boolean }

const people: Person[] = [
  { id: '5511911110001@c.us', name: 'Ana Souza', phone: '+5511911110001', about: 'Disponível' },
  { id: '5511911110002@c.us', name: 'Pedro Lima', phone: '+5511911110002', about: 'No trabalho' },
  { id: '5511911110003@c.us', name: 'Bruno', phone: '+5511911110003', about: 'Bora!' },
  { id: '5511911110004@c.us', name: 'André Costa', phone: '+5511911110004', about: 'Dev React' },
  { id: '5511911110005@c.us', name: 'Érica', phone: '+5511911110005', about: '🌻' },
  { id: '5511911110006@c.us', name: 'Mãe', phone: '+5511911110006', about: 'Família em primeiro lugar' },
  { id: '5511911110007@c.us', name: 'José', phone: '+5511911110007', about: 'Corinthians ⚽' },
  { id: '5511911110008@c.us', name: 'Loja do Bairro', phone: '+5511911110008', about: 'Conta comercial' },
]
const P = Object.fromEntries(people.map((person) => [person.name.split(' ')[0]!.toLowerCase(), person.id])) as Record<string, string>
const SINDICO = '5511922220000@c.us'
const nameOf = (id: string) => (id === ME.id ? 'Você' : id === SINDICO ? 'Síndico' : people.find((person) => person.id === id)?.name || `+${id.split('@')[0]}`)

const chats = new Map<string, Contact>()
const messages = new Map<string, ChatMessage[]>()
/** Older messages not shown yet ("carregar anteriores" moves them into `messages`). */
const older = new Map<string, ChatMessage[]>()
const groups = new Map<string, GroupInfo>()
const photos = new Map<string, string>()
const blocked = new Set<string>()
const disappearing = new Map<string, number>()
const statuses: { id: string; name: string; unread: number; text: string; at: number }[] = []
const timers = new Set<ReturnType<typeof setTimeout>>()
let ticker: ReturnType<typeof setInterval> | undefined
let seq = 0

let state: ConnectionState = { status: 'idle', qr: null, me: null }

// ---------- small helpers ----------

function later(ms: number, fn: () => void) {
  const timer = setTimeout(() => {
    timers.delete(timer)
    fn()
  }, ms)
  timers.add(timer)
}

function setState(patch: Partial<ConnectionState>) {
  state = { ...state, ...patch }
  waEvents.emit('state', state)
}

let chatsTimer: ReturnType<typeof setTimeout> | undefined
function emitChats() {
  clearTimeout(chatsTimer)
  chatsTimer = setTimeout(() => waEvents.emit('chats', listChats()), 100)
}

function svgData(svg: string) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
}

function avatar(name: string, color: string) {
  return svgData(
    `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="${color}"/>` +
      `<text x="48" y="50" font-family="Arial, sans-serif" font-size="36" font-weight="bold" fill="#fff" text-anchor="middle" dominant-baseline="middle">${initials(name)}</text></svg>`,
  )
}

const LANDSCAPE = svgData(
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#7cc4ff"/><stop offset="1" stop-color="#ffd59e"/></linearGradient></defs>' +
    '<rect width="320" height="200" fill="url(#s)"/><circle cx="250" cy="58" r="26" fill="#fff3b0"/>' +
    '<path d="M0 160 L80 90 L150 150 L210 100 L320 170 L320 200 L0 200Z" fill="#2f6f4e"/></svg>',
)

const DOCUMENT = `data:text/plain;base64,${Buffer.from('Orçamento de teste\n\nItem 1 ..... R$ 100,00\nItem 2 ..... R$ 250,00\n\nArquivo gerado pelo modo teste.').toString('base64')}`

/** Ids shaped like real WhatsApp ones (true_<chat>_<key>[_<sender>]), so the app's id logic is exercised. */
function newId(chatId: string, fromMe: boolean, author = '') {
  seq += 1
  const key = `FAKE${Date.now().toString(36).toUpperCase()}${seq.toString(36).toUpperCase().padStart(3, '0')}`
  const sender = chatId.endsWith('@g.us') ? `_${fromMe ? ME.id : author}` : ''
  return `${fromMe ? 'true' : 'false'}_${chatId}_${key}${sender}`
}

function isGroup(id: string) {
  return id.endsWith('@g.us')
}

function addChat(id: string, name: string, extra: Partial<Contact> = {}) {
  const color = colorFor(id)
  const contact: Contact = {
    id,
    name,
    phone: isGroup(id) ? '' : `+${id.split('@')[0]}`,
    initials: initials(name),
    color,
    lastSeen: isGroup(id) ? 'grupo' : 'visto por último hoje',
    online: false,
    lastAt: 0,
    isGroup: isGroup(id),
    unread: 0,
    muted: false,
    pinned: false,
    archived: false,
    typing: '',
    ...extra,
  }
  chats.set(id, contact)
  photos.set(id, avatar(name, color))
  return contact
}

function patchChat(id: string, patch: Partial<Contact>) {
  const current = chats.get(id)
  if (!current) return
  chats.set(id, { ...current, ...patch })
  emitChats()
}

/** Adds a message, keeps the chat list in order and tells the app. */
function push(message: ChatMessage, options: { emit?: boolean; countUnread?: boolean } = {}) {
  const list = messages.get(message.contactId) ?? []
  messages.set(message.contactId, [...list, message].sort((a, b) => a.at - b.at))
  const chat = chats.get(message.contactId)
  if (chat) {
    const unread = !message.fromMe && options.countUnread ? (chat.unread ?? 0) + 1 : chat.unread
    // Like current WhatsApp ("keep chats archived"), new messages don't unarchive a chat.
    chats.set(message.contactId, { ...chat, lastAt: Math.max(chat.lastAt, message.at), unread })
    emitChats()
  }
  if (options.emit !== false) waEvents.emit('message', message)
  return message
}

function patchMessage(contactId: string, id: string, patch: Partial<ChatMessage>) {
  const list = messages.get(contactId) ?? []
  const current = list.find((item) => sameMessageId(item.id, id))
  if (!current) return null
  const next = { ...current, ...patch }
  messages.set(contactId, list.map((item) => (item === current ? next : item)))
  waEvents.emit('message', next)
  return next
}

function findMessage(id: string) {
  for (const [contactId, list] of messages) {
    const found = list.find((item) => sameMessageId(item.id, id))
    if (found) return { contactId, message: found }
  }
  return null
}

function text(contactId: string, body: string, at: number, from = '', extra: Partial<ChatMessage> = {}): ChatMessage {
  const fromMe = !from || from === ME.id
  return {
    id: newId(contactId, fromMe, from),
    contactId,
    text: body,
    fromMe,
    at,
    status: 'read',
    kind: 'text',
    authorId: isGroup(contactId) && !fromMe ? from : undefined,
    authorName: isGroup(contactId) && !fromMe ? nameOf(from) : undefined,
    ...extra,
  }
}

function pollOf(name: string, options: string[], multi: boolean, votes: Record<string, number[]> = {}): Poll {
  const poll: Poll = {
    name,
    multi,
    options: options.map((option, index) => ({ id: index, name: option, votes: 0, voters: [], mine: false })),
    voters: 0,
  }
  return withVotes(poll, votes)
}

/** Rebuilds the counts from a voter → option ids map (each voter's latest choice). */
function withVotes(poll: Poll, votes: Record<string, number[]>): Poll {
  const options = poll.options.map((option) => ({ ...option, votes: 0, voters: [] as string[], mine: false }))
  let voters = 0
  for (const [who, picked] of Object.entries(votes)) {
    if (!picked.length) continue
    voters += 1
    for (const id of picked) {
      const option = options.find((item) => item.id === id)
      if (!option) continue
      option.votes += 1
      option.voters.push(nameOf(who))
      if (who === ME.id) option.mine = true
    }
  }
  return { ...poll, options, voters }
}
const pollVotes = new Map<string, Record<string, number[]>>()

// ---------- seed data ----------

function seed() {
  chats.clear()
  messages.clear()
  older.clear()
  groups.clear()
  photos.clear()
  blocked.clear()
  disappearing.clear()
  pollVotes.clear()
  statuses.length = 0
  const now = Date.now()

  for (const person of people) addChat(person.id, person.name)
  const FAMILIA = '120363000000000001@g.us'
  const TRABALHO = '120363000000000002@g.us'
  const VAGAS = '120363000000000003@g.us'
  const FACULDADE = '120363000000000004@g.us'
  const CONDOMINIO = '120363000000000005@g.us'
  addChat(FAMILIA, 'Família', { pinned: true })
  addChat(TRABALHO, 'Trabalho')
  addChat(VAGAS, 'Vagas T.I. - Todos os Estados', { muted: true })
  addChat(FACULDADE, 'Grupo da Faculdade')
  addChat(CONDOMINIO, 'Condomínio Jardim', { archived: true })
  groups.set(FAMILIA, { members: [ME.id, P.mãe!, P.josé!, P.érica!], admins: [ME.id, P.mãe!], description: 'Grupo da família 💚' })
  groups.set(TRABALHO, { members: [ME.id, P.ana!, P.pedro!, P.bruno!], admins: [ME.id], description: 'Assuntos do trabalho' })
  groups.set(VAGAS, { members: [ME.id, P.andré!, P.pedro!], admins: [P.andré!], description: 'Só vagas. Sem spam.' })
  groups.set(FACULDADE, { members: [ME.id, P.bruno!, P.érica!], admins: [ME.id, P.bruno!], description: 'Turma 2026' })
  groups.set(CONDOMINIO, { members: [ME.id, SINDICO, P.josé!], admins: [SINDICO], description: 'Avisos do condomínio' })

  const ago = (minutes: number) => now - minutes * MIN
  const add = (message: ChatMessage, unread = false) => push(message, { emit: false, countUnread: unread })

  add(text(P.ana!, 'Oi! Tudo bem?', ago(26 * 60), P.ana))
  add(text(P.ana!, 'Tudo ótimo e você?', ago(26 * 60 - 3)))
  add(text(P.ana!, 'Bem também! Amanhã a reunião é às 10h, ok?', ago(26 * 60 - 5), P.ana))
  add(text(P.ana!, 'Me manda o relatório quando puder 🙏', ago(40), P.ana), true)

  const mine = add(text(P.pedro!, 'Mandei o pix agora!', ago(3 * 60)))
  add(text(P.pedro!, 'Fechou o pix? A chave é pedro@email.com', ago(3 * 60 + 5), P.pedro))
  patchMessage(P.pedro!, mine.id, { reactions: [{ emoji: '👍', fromMe: false, author: P.pedro }] })

  // Bruno: long history, to test "carregar mensagens anteriores".
  const brunoOld: ChatMessage[] = []
  for (let index = 1; index <= 60; index++) {
    const fromBruno = index % 3 !== 0
    brunoOld.push(text(P.bruno!, `Mensagem antiga nº ${index}`, ago(5 * 24 * 60 - index * 90), fromBruno ? P.bruno : ''))
  }
  older.set(P.bruno!, brunoOld.slice(0, 40))
  for (const message of brunoOld.slice(40)) add(message)
  add(text(P.bruno!, 'Bora jogar bola sábado?', ago(90), P.bruno))

  add(text(P.andré!, 'Olha essa vista!', ago(5 * 60), P.andré, { kind: 'image', media: LANDSCAPE }))
  add(text(P.érica!, 'orcamento.txt', ago(8 * 60), P.érica, { kind: 'document', media: DOCUMENT, filename: 'orcamento.txt' }))
  add(text(P.érica!, 'Segue o orçamento que você pediu', ago(8 * 60 - 1), P.érica))
  add(text(P.mãe!, 'Comprei pão 🍞', ago(70), P.mãe), true)
  add(text(P.mãe!, 'Filho, liga pra mim quando puder ❤️', ago(15), P.mãe), true)
  const game = add(text(P.josé!, 'Vamos no jogo sábado?', ago(2 * 60)))
  add(text(P.josé!, 'Bora! Que horas?', ago(2 * 60 - 4), P.josé, { quote: { id: game.id, text: game.text } }))
  add(text(P.loja!, 'Seu pedido #1234 saiu para entrega 🚚', ago(25), P.loja), true)

  add(text(FAMILIA, 'Bom dia família ☀️', ago(6 * 60), P.mãe))
  const lunch = text(FAMILIA, '📊 Almoço de domingo', ago(5 * 60), P.mãe)
  pollVotes.set(lunch.id, { [P.mãe!]: [0], [P.josé!]: [0], [P.érica!]: [1] })
  lunch.poll = pollOf('Almoço de domingo', ['Churrasco', 'Pizza', 'Lasanha'], false, pollVotes.get(lunch.id))
  add(lunch)
  add(text(FAMILIA, 'Churrasco sempre 😂', ago(4 * 60), P.josé, { reactions: [{ emoji: '😂', fromMe: false, author: P.érica }] }))
  add(text(TRABALHO, 'Reunião às 15h na sala 2', ago(4 * 60), P.pedro))
  add(text(TRABALHO, 'Ok!', ago(4 * 60 - 2), P.ana))
  add(text(VAGAS, 'Vaga Dev React — remoto — CLT', ago(30), P.andré), true)
  add(text(VAGAS, 'Vaga QA Pleno — São Paulo', ago(20), P.andré), true)
  add(text(FACULDADE, 'Prova adiada pra sexta 🎉', ago(12 * 60), P.bruno))
  add(text(CONDOMINIO, 'Aviso: falta de água amanhã das 8h às 12h', ago(9 * 60), SINDICO))

  statuses.push(
    { id: P.ana!, name: 'Ana Souza', unread: 1, text: 'Partiu praia 🏖️', at: ago(50) },
    { id: P.pedro!, name: 'Pedro Lima', unread: 1, text: 'Foto', at: ago(120) },
    { id: P.érica!, name: 'Érica', unread: 0, text: 'Vídeo', at: ago(300) },
  )
  photos.set(ME.id, avatar(ME.name, '#6a7175'))
}

// ---------- automatic behaviour ----------

function deliver(message: ChatMessage) {
  later(900, () => patchMessage(message.contactId, message.id, { status: 'delivered' }))
  later(isGroup(message.contactId) ? 4000 : 2600, () => patchMessage(message.contactId, message.id, { status: 'read' }))
}

const REPLIES = ['Beleza!', 'Combinado 👍', 'Valeu!', 'Kkkk boa', 'Pode deixar.', 'Show!']
let replyAt = 0

function replyFor(body: string) {
  const low = body.toLowerCase()
  if (/\b(oi|olá|ola|bom dia|boa tarde|boa noite)\b/.test(low)) return 'Oi! 😊 Tudo bem?'
  if (low.includes('?')) return 'Hmm, deixa eu ver e já te respondo.'
  replyAt = (replyAt + 1) % REPLIES.length
  return REPLIES[replyAt]!
}

/** 1:1 chats: the person types for a moment and answers. Groups: someone reacts 👍. */
function react(to: ChatMessage) {
  const chatId = to.contactId
  if (isGroup(chatId)) {
    const member = groups.get(chatId)?.members.find((id) => id !== ME.id)
    if (!member) return
    later(3000, () => {
      const current = (messages.get(chatId) ?? []).find((item) => item.id === to.id)
      if (current) patchMessage(chatId, to.id, { reactions: [...(current.reactions ?? []), { emoji: '👍', fromMe: false, author: member }] })
    })
    return
  }
  if (!people.some((person) => person.id === chatId) || blocked.has(chatId)) return
  later(1200, () => patchChat(chatId, { typing: 'digitando...', online: true, lastSeen: 'online' }))
  later(3600, () => {
    patchChat(chatId, { typing: '', online: true })
    push(text(chatId, to.text ? replyFor(to.text) : 'Recebi! 👍', Date.now(), chatId), { countUnread: true })
  })
  later(9000, () => patchChat(chatId, { online: false, lastSeen: 'visto por último hoje' }))
}

const RANDOM_MESSAGES = ['Tá aí?', 'Viu meu recado?', 'Me liga depois', 'Kkkkkk', 'Bom dia! ☀️', 'Chegou aí?']

function startTicker() {
  clearInterval(ticker)
  // Every 2 minutes someone writes to you, to test unread counts and notifications.
  ticker = setInterval(() => {
    if (state.status !== 'ready') return
    const person = people[Math.floor(Math.random() * people.length)]!
    if (blocked.has(person.id)) return
    const body = RANDOM_MESSAGES[Math.floor(Math.random() * RANDOM_MESSAGES.length)]!
    push(text(person.id, body, Date.now(), person.id), { countUnread: true })
  }, 2 * MIN)
}

// ---------- the API used by server/index.ts (same as ./whatsapp.ts) ----------

export function getState() {
  return state
}

export function listChats() {
  return [...chats.values()].sort((a, b) => b.lastAt - a.lastAt)
}

export function listMessages(jid: string) {
  return messages.get(jid) ?? []
}

export function listPhotos() {
  return [...photos.entries()].map(([id, photo]) => ({ id, photo }))
}

export function hydrateCache() {
  /* the fake never reads the real cache */
}

export async function startWhatsApp() {
  if (state.status === 'ready' || state.status === 'connecting') return
  console.log('[fake] MODO TESTE: WhatsApp de mentira, nada vai para o seu WhatsApp de verdade')
  setState({ status: 'connecting', qr: null })
  await sleep(1200)
  seed()
  setState({ status: 'ready', qr: null, me: { ...ME } })
  waEvents.emit('messages-sync')
  waEvents.emit('photos', listPhotos())
  startTicker()
}

export async function destroyWhatsApp() {
  for (const timer of timers) clearTimeout(timer)
  timers.clear()
  clearInterval(ticker)
}

function requireReady() {
  if (state.status !== 'ready') throw new Error('WhatsApp não está conectado')
}

function requireChat(id: string) {
  const chat = chats.get(id)
  if (!chat) throw new Error('Contato inválido')
  return chat
}

function canSend(jid: string) {
  requireReady()
  if (!isUsefulJid(jid)) throw new Error('Contato inválido')
  requireChat(jid)
  if (blocked.has(jid)) throw new Error('Você bloqueou este contato. Desbloqueie para mandar mensagem.')
  if (groups.get(jid)?.left) throw new Error('Você não participa mais deste grupo.')
}

export async function sendText(
  jid: string,
  body: string,
  viaBlast = false,
  quoted?: { id: string; text: string },
  _mentions: string[] = [],
) {
  canSend(jid)
  if (!body.trim()) throw new Error('Mensagem vazia: nada foi enviado')
  const message = push({ ...text(jid, body, Date.now()), status: 'sent', viaBlast, quote: quoted })
  deliver(message)
  react(message)
  return message
}

function asDataUrl(file: CommandFile) {
  if (file.data.startsWith('data:')) return file.data
  return `data:${file.mimetype || 'application/octet-stream'};base64,${file.data}`
}

export async function sendChatFile(
  jid: string,
  file: CommandFile,
  kind: 'photo' | 'audio' | 'video' | 'document' | 'sticker' | 'gif',
  caption = '',
) {
  canSend(jid)
  if (!file?.data) throw new Error('Anexe um arquivo')
  const message = push({
    ...text(jid, caption.trim() || (kind === 'document' ? file.name : ''), Date.now()),
    status: 'sent',
    kind: kind === 'photo' ? 'image' : kind === 'gif' ? 'video' : kind,
    gif: kind === 'gif' || undefined,
    media: asDataUrl(file),
    filename: kind === 'document' ? file.name : undefined,
  })
  deliver(message)
  react(message)
  return message
}

let blasting = false

export async function sendBlast(contactIds: string[], template: string) {
  if (blasting) throw new Error('Já tem um disparo em andamento')
  requireReady()
  blasting = true
  const unique = [...new Set(contactIds)].filter(isUsefulJid)
  const results: BlastProgress[] = []
  try {
    for (let index = 0; index < unique.length; index++) {
      if (index > 0) await sleep(800)
      const contactId = unique[index]!
      const contact = chats.get(contactId) ?? { name: nameOf(contactId) }
      try {
        // "via disparo" only marks real bulk sends (more than one person).
        await sendText(contactId, renderTemplate(template, contact), unique.length > 1)
        results.push({ contactId, name: contact.name, ok: true, index: index + 1, total: unique.length })
      } catch (error) {
        results.push({
          contactId,
          name: contact.name,
          ok: false,
          error: error instanceof Error ? error.message : 'Falha ao enviar',
          index: index + 1,
          total: unique.length,
        })
      }
      waEvents.emit('blast:progress', results.at(-1))
    }
  } finally {
    blasting = false
  }
  return { sent: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length, results }
}

export async function sendMediaBlast(contactIds: string[], file: CommandFile, caption = '', kind: 'photo' | 'audio' = 'photo') {
  requireReady()
  const unique = [...new Set(contactIds)].filter(isUsefulJid)
  if (!unique.length) throw new Error('Selecione pelo menos um contato')
  const results: BlastProgress[] = []
  for (let index = 0; index < unique.length; index++) {
    const contactId = unique[index]!
    const name = chats.get(contactId)?.name || nameOf(contactId)
    try {
      await sendChatFile(contactId, file, kind, caption)
      results.push({ contactId, name, ok: true, index: index + 1, total: unique.length })
    } catch (error) {
      results.push({ contactId, name, ok: false, error: error instanceof Error ? error.message : 'Falha', index: index + 1, total: unique.length })
    }
    waEvents.emit('blast:progress', results.at(-1))
  }
  return { sent: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length, results }
}

export async function createGroupCommand(contactIds: string[], title: string) {
  requireReady()
  const name = title.replace(/^(criar grupo|novo grupo|\/grupo)\s*/i, '').trim()
  if (!name) throw new Error('Digite o nome do grupo')
  const members = [...new Set(contactIds)].filter((id) => people.some((person) => person.id === id))
  if (!members.length) throw new Error('Marque pelo menos um contato com @')
  const id = `1203630000${String(Date.now()).slice(-8)}@g.us`
  addChat(id, name, { lastAt: Date.now() })
  photos.set(id, avatar(name, colorFor(id)))
  waEvents.emit('photos', [{ id, photo: photos.get(id)! }])
  groups.set(id, { members: [ME.id, ...members], admins: [ME.id], description: '' })
  push(text(id, `Você criou o grupo “${name}”`, Date.now()))
  return { ok: true, groupId: id, title: name, added: members.length }
}

function messageIdsFor(contactId: string, messageIds?: string[], fromMe = false) {
  const picked = (messageIds ?? []).filter(Boolean)
  if (picked.length) return picked
  const last = listMessages(contactId).filter((item) => (fromMe ? item.fromMe : true)).at(-1)
  return last ? [last.id] : []
}

const CHAT_LABELS: Partial<Record<CommandAction, string>> = {
  unmute: 'Notificações ativadas.',
  archive: 'Conversa arquivada.',
  unarchive: 'Conversa desarquivada.',
  unpin: 'Conversa desafixada.',
  block: 'Contato bloqueado.',
  unblock: 'Contato desbloqueado.',
}

async function chatAction(type: CommandAction, contactId: string, detail: string) {
  requireReady()
  if (!contactId) throw new Error('Escolha a conversa')
  requireChat(contactId)
  if ((type === 'block' || type === 'unblock') && isGroup(contactId)) throw new Error('Bloqueio vale para contato, não para grupo')
  if (type === 'mute') {
    patchChat(contactId, { muted: true })
    return detail === '8h' || detail === '1w' ? 'Notificações silenciadas.' : 'Notificações silenciadas até você ligar de novo.'
  }
  if (type === 'unmute') patchChat(contactId, { muted: false })
  if (type === 'archive') patchChat(contactId, { archived: true })
  if (type === 'unarchive') patchChat(contactId, { archived: false })
  if (type === 'pin') {
    if (listChats().filter((chat) => chat.pinned).length >= 3) throw new Error('Não deu para fixar. O topo já pode estar cheio.')
    patchChat(contactId, { pinned: true })
    return 'Conversa adicionada aos favoritos e fixada no topo.'
  }
  if (type === 'unpin') patchChat(contactId, { pinned: false })
  if (type === 'block') blocked.add(contactId)
  if (type === 'unblock') blocked.delete(contactId)
  if (type === 'call') return `Link da chamada: https://call.whatsapp.com/${detail === 'voice' ? 'voice' : 'video'}/TESTE-${Date.now().toString(36)}`
  if (type === 'disappearing') {
    const seconds = Number(detail || 0)
    disappearing.set(contactId, seconds)
    if (seconds === 86400) return 'Mensagens temporárias: 24 horas.'
    if (seconds === 604800) return 'Mensagens temporárias: 7 dias.'
    if (seconds === 7776000) return 'Mensagens temporárias: 90 dias.'
    return 'Mensagens temporárias desligadas.'
  }
  return CHAT_LABELS[type] || 'Pronto.'
}

export async function votePoll(contactId: string, messageId: string, optionIds: number[]) {
  requireReady()
  const found = (messages.get(contactId) ?? []).find((item) => sameMessageId(item.id, messageId))
  if (!found?.poll) throw new Error('Não achei a enquete')
  const votes = { ...(pollVotes.get(found.id) ?? {}), [ME.id]: found.poll.multi ? optionIds : optionIds.slice(0, 1) }
  pollVotes.set(found.id, votes)
  const poll = withVotes(found.poll, votes)
  patchMessage(contactId, found.id, { poll })
  return poll
}

/** Group members vote on a poll you created, one by one. */
function othersVote(message: ChatMessage) {
  const members = groups.get(message.contactId)?.members.filter((id) => id !== ME.id) ?? []
  members.forEach((member, index) => {
    later(2500 + index * 2000, () => {
      const current = (messages.get(message.contactId) ?? []).find((item) => item.id === message.id)
      if (!current?.poll) return
      const pick = (index + 1) % current.poll.options.length
      const votes = { ...(pollVotes.get(message.id) ?? {}), [member]: [pick] }
      pollVotes.set(message.id, votes)
      patchMessage(message.contactId, message.id, { poll: withVotes(current.poll, votes) })
    })
  })
}

export async function runWhatsAppCommand(input: {
  type: CommandAction
  contactIds: string[]
  text?: string
  file?: CommandFile
  messageIds?: string[]
}) {
  requireReady()
  const contactId = input.contactIds[0] || ''
  if (input.type === 'reply') {
    const quoted = messageIdsFor(contactId, input.messageIds)[0]
    if (!quoted) throw new Error('Não achei a mensagem para responder')
    if (!input.text?.trim()) throw new Error('Digite a resposta')
    const preview = listMessages(contactId).find((item) => sameMessageId(item.id, quoted))
    await sendText(contactId, input.text.trim(), false, { id: quoted, text: (preview?.text || preview?.kind || 'mensagem').slice(0, 80) })
    return { sent: 1, failed: 0, message: 'Resposta enviada.' }
  }
  if (input.type === 'react') {
    const target = messageIdsFor(contactId, input.messageIds)[0]
    const current = target ? listMessages(contactId).find((item) => sameMessageId(item.id, target)) : undefined
    if (!current) throw new Error('Não achei a mensagem para reagir')
    const emoji = input.text?.trim() || '👍'
    patchMessage(contactId, current.id, { reactions: [...(current.reactions ?? []).filter((item) => !item.fromMe), { emoji, fromMe: true, author: ME.id }] })
    return { sent: 1, failed: 0, message: `Reação ${emoji} enviada.` }
  }
  if (input.type === 'delete') {
    const everyone = input.text !== 'me'
    const targets = messageIdsFor(contactId, input.messageIds, everyone)
    if (!targets.length) throw new Error(everyone ? 'Não achei uma mensagem sua para apagar' : 'Não achei a mensagem para apagar')
    if (everyone && targets.some((id) => !listMessages(contactId).find((item) => sameMessageId(item.id, id))?.fromMe)) {
      throw new Error('Só dá para apagar para todos as suas mensagens')
    }
    messages.set(contactId, listMessages(contactId).filter((item) => !targets.some((id) => sameMessageId(item.id, id))))
    const count = targets.length
    return {
      sent: count,
      failed: 0,
      message: everyone ? `${count} mensagem(ns) apagada(s) para todos.` : `${count} mensagem(ns) apagada(s) para você.`,
      removedIds: targets,
    }
  }
  if (input.type === 'forward') {
    const ids = (input.messageIds ?? []).filter(Boolean)
    if (!ids.length) throw new Error('Selecione a mensagem para encaminhar')
    if (!contactId) throw new Error('Diga para quem encaminhar')
    canSend(contactId)
    for (const id of ids) {
      const found = findMessage(id)
      if (!found) continue
      // A forwarded copy keeps the content only (no reactions, stars, quote or votes).
      const copy = push({
        ...text(contactId, found.message.text, Date.now()),
        kind: found.message.kind,
        media: found.message.media,
        filename: found.message.filename,
        status: 'sent',
      })
      deliver(copy)
    }
    return { sent: ids.length, failed: 0, message: 'Mensagem encaminhada.' }
  }
  if (input.type === 'star' || input.type === 'unstar') {
    const ids = messageIdsFor(contactId, input.messageIds)
    if (!ids.length) throw new Error('Não achei a mensagem')
    for (const id of ids) patchMessage(contactId, id, { starred: input.type === 'star' })
    return { sent: ids.length, failed: 0, message: input.type === 'star' ? 'Mensagem destacada.' : 'Destaque removido.' }
  }
  if (input.type === 'edit') {
    const id = messageIdsFor(contactId, input.messageIds, true)[0]
    if (!id) throw new Error('Não achei uma mensagem sua para editar')
    if (!input.text?.trim()) throw new Error('Digite o novo texto')
    const current = listMessages(contactId).find((item) => sameMessageId(item.id, id))
    if (!current?.fromMe) throw new Error('Só dá para editar uma mensagem sua')
    if (Date.now() - current.at > 15 * MIN) throw new Error('Só dá para editar uma mensagem sua recente (até 15 minutos)')
    patchMessage(contactId, id, { text: input.text.trim() })
    return { sent: 1, failed: 0, message: 'Mensagem editada.' }
  }
  if (input.type === 'pinmsg' || input.type === 'unpinmsg') {
    const id = messageIdsFor(contactId, input.messageIds)[0]
    if (!id) throw new Error('Não achei a mensagem para fixar')
    patchMessage(contactId, id, { pinned: input.type === 'pinmsg' })
    return { sent: 1, failed: 0, message: input.type === 'pinmsg' ? 'Mensagem fixada por 7 dias.' : 'Mensagem desafixada.' }
  }
  if (input.type === 'unread') {
    if (!contactId) throw new Error('Abra a conversa')
    patchChat(contactId, { unread: Math.max(1, chats.get(contactId)?.unread ?? 0) })
    return { sent: 1, failed: 0, message: 'Conversa marcada como não lida.' }
  }
  if (input.type === 'clear') {
    if (!contactId) throw new Error('Abra a conversa')
    messages.set(contactId, [])
    return { sent: 1, failed: 0, message: 'Conversa limpa.', cleared: true }
  }
  if (input.type === 'contact') {
    const [name, phone] = (input.text || '').split('|')
    const digits = (phone || '').replace(/\D/g, '')
    if (!name || !digits) throw new Error('Diga o contato, tipo: manda o contato do Pedro')
    canSend(contactId)
    deliver(push({ ...text(contactId, `👤 ${name} (+${digits})`, Date.now()), status: 'sent' }))
    return { sent: 1, failed: 0, message: `Contato ${name} enviado.` }
  }
  if (input.type === 'poll') {
    const parts = (input.text || '').split('|').map((part) => part.trim()).filter(Boolean)
    if (parts.length < 3) throw new Error('Use: enquete Pergunta | opção 1 | opção 2')
    canSend(contactId)
    const message = text(contactId, `📊 ${parts[0]}`, Date.now())
    message.status = 'sent'
    message.poll = pollOf(parts[0]!, parts.slice(1), false)
    pollVotes.set(message.id, {})
    push(message)
    deliver(message)
    if (isGroup(contactId)) othersVote(message)
    return { sent: 1, failed: 0, message: 'Enquete enviada.' }
  }
  if (input.type === 'label') {
    if (!input.text?.trim()) throw new Error('Diga o nome da lista, tipo: lista Trabalho')
    return { sent: 1, failed: 0, message: `Conversa na lista ${input.text.trim()}.` }
  }
  if (['mute', 'unmute', 'disappearing', 'block', 'unblock', 'archive', 'unarchive', 'pin', 'unpin', 'call'].includes(input.type)) {
    return { sent: 1, failed: 0, message: await chatAction(input.type, contactId, input.text || '') }
  }
  if (input.type === 'group') {
    const created = await createGroupCommand(input.contactIds, input.text || '')
    return { sent: created.added, failed: 0, groupId: created.groupId, title: created.title }
  }
  if (['photo', 'audio', 'video', 'document', 'sticker', 'gif'].includes(input.type)) {
    if (!input.file) throw new Error('Anexe o arquivo')
    const kind = input.type as 'photo' | 'audio' | 'video' | 'document' | 'sticker' | 'gif'
    if (input.contactIds.length === 1) {
      await sendChatFile(contactId, input.file, kind, input.text || '')
      return { sent: 1, failed: 0, message: 'Arquivo enviado.' }
    }
    if (kind !== 'photo' && kind !== 'audio') throw new Error('Disparo em massa vale para texto, foto e áudio')
    return sendMediaBlast(input.contactIds, input.file, input.text || '', kind)
  }
  return sendBlast(input.contactIds, input.text || '')
}

export function watchChat(_contactId: string) {
  /* presence is simulated by the auto-replies */
}

export async function markRead(contactId: string) {
  requireReady()
  patchChat(contactId, { unread: 0 })
}

export async function sendTyping(_contactId: string, _on: boolean) {
  requireReady()
}

export async function loadThread(contactId: string) {
  return listMessages(contactId)
}

export async function loadEarlier(contactId: string, beforeMs: number) {
  const pool = older.get(contactId) ?? []
  const page = pool.filter((message) => message.at < beforeMs).slice(-30)
  if (page.length) {
    older.set(contactId, pool.filter((message) => !page.includes(message)))
    messages.set(contactId, [...page, ...listMessages(contactId)].sort((a, b) => a.at - b.at))
  }
  const list = listMessages(contactId)
  waEvents.emit('thread', { contactId, messages: list })
  return list
}

function library(list: ChatMessage[], test: (message: ChatMessage) => boolean): LibraryItem[] {
  return list.filter(test).map((message) => ({ id: message.id, kind: message.kind || 'text', text: message.text || message.filename || '', at: message.at }))
}

export async function loadProfile(contactId: string) {
  const chat = chats.get(contactId)
  const list = [...(older.get(contactId) ?? []), ...listMessages(contactId)]
  const group = groups.get(contactId)
  const participants: Participant[] = (group?.members ?? []).map((id) => ({
    id,
    name: nameOf(id),
    phone: `+${id.split('@')[0]}`,
    isAdmin: group?.admins.includes(id) ?? false,
  }))
  const commonGroups: CommonGroup[] = isGroup(contactId)
    ? []
    : [...groups.entries()]
        .filter(([, info]) => info.members.includes(contactId))
        .map(([id]) => ({ id, name: chats.get(id)?.name || 'Grupo', preview: listMessages(id).at(-1)?.text || '' }))
  const seconds = disappearing.get(contactId) ?? 0
  const mediaItems = library(list, (message) => message.kind === 'image' || message.kind === 'video')
  const linkItems = library(list, (message) => /https?:\/\//.test(message.text))
  const docItems = library(list, (message) => message.kind === 'document')
  const starredItems = library(list, (message) => Boolean(message.starred))
  const profile: ChatProfile = {
    description: group?.description ?? people.find((person) => person.id === contactId)?.about ?? '',
    phone: chat?.phone || '',
    muted: Boolean(chat?.muted),
    disappearing: seconds === 86400 ? '24 horas' : seconds === 604800 ? '7 dias' : seconds === 7776000 ? '90 dias' : 'Desligadas',
    media: mediaItems.length,
    links: linkItems.length,
    docs: docItems.length,
    starred: starredItems.length,
    participants,
    commonGroups,
    mediaItems,
    linkItems,
    docItems,
    starredItems,
  }
  return profile
}

export async function openNumber(raw: string) {
  requireReady()
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8) throw new Error('Digite o número com DDD')
  // Any number ending in 0000 plays "not on WhatsApp", to test that error.
  if (digits.endsWith('0000')) throw new Error('Esse número não está no WhatsApp')
  const id = `${digits}@c.us`
  if (!chats.has(id)) addChat(id, `+${digits}`, { lastAt: Date.now() })
  emitChats()
  return chats.get(id)!
}

export async function fetchMessageMedia(contactId: string, messageId: string) {
  requireReady()
  const found = listMessages(contactId).find((item) => sameMessageId(item.id, messageId))
  if (!found?.media) throw new Error('Não deu para baixar essa mídia')
  return found.media
}

export async function searchMessages(query: string) {
  requireReady()
  const needle = query.trim().toLowerCase()
  if (needle.length < 2) return []
  const hits: { contactId: string; contactName: string; messageId: string; text: string; at: number }[] = []
  for (const [contactId, list] of messages) {
    for (const message of [...list].reverse()) {
      if (hits.length >= 40) break
      if (!message.text.toLowerCase().includes(needle)) continue
      hits.push({ contactId, contactName: chats.get(contactId)?.name || '', messageId: message.id, text: message.text.slice(0, 160), at: message.at })
    }
  }
  return hits
}

export async function exportHistory(contactId: string) {
  requireReady()
  return [...(older.get(contactId) ?? []), ...listMessages(contactId)].sort((a, b) => a.at - b.at)
}

export async function messageInfo(messageId: string) {
  requireReady()
  const found = findMessage(messageId)
  if (!found?.message.fromMe) return { delivered: [] as string[], read: [] as string[] }
  const others = isGroup(found.contactId)
    ? (groups.get(found.contactId)?.members ?? []).filter((id) => id !== ME.id).map(nameOf)
    : [nameOf(found.contactId)]
  const status = found.message.status
  return {
    delivered: status === 'sent' ? [] : others,
    read: status === 'read' ? others.slice(0, Math.max(1, Math.ceil(others.length / 2))) : [],
  }
}

export async function reportChat(contactId: string) {
  requireReady()
  requireChat(contactId)
  return 'Denúncia enviada ao WhatsApp. (modo teste: nada foi enviado de verdade)'
}

export async function listStatuses() {
  requireReady()
  return statuses.map((item) => ({ ...item }))
}

export async function postStatus(body: string, file?: CommandFile) {
  requireReady()
  if (!body.trim() && !file?.data) throw new Error('Escreva o status ou anexe uma foto')
  statuses.unshift({ id: ME.id, name: 'Meu status', unread: 0, text: body.trim() || 'Foto', at: Date.now() })
  return 'Status publicado.'
}

export async function startCall(contactId: string, video: boolean) {
  requireReady()
  requireChat(contactId)
  return {
    mode: 'link' as const,
    link: `https://call.whatsapp.com/${video ? 'video' : 'voice'}/TESTE-${Date.now().toString(36)}`,
    message: 'Modo teste: a chamada não toca de verdade. O link (falso) está pronto.',
  }
}

export async function groupAction(input: {
  contactId: string
  action: 'add' | 'remove' | 'promote' | 'demote' | 'leave' | 'subject' | 'description' | 'picture' | 'invite'
  participantId?: string
  text?: string
  file?: CommandFile
}) {
  requireReady()
  if (!isGroup(input.contactId)) throw new Error('Isso só funciona em grupo')
  const group = groups.get(input.contactId)
  if (!group) throw new Error('Essa conversa não é um grupo')
  if (group.left) throw new Error('Você não participa mais deste grupo.')
  const admin = group.admins.includes(ME.id)
  const refused = 'O WhatsApp não deixou. Neste grupo, só os admins podem mudar isso.'
  const note = (body: string) => push(text(input.contactId, body, Date.now()))

  if (input.action === 'leave') {
    group.left = true
    group.members = group.members.filter((id) => id !== ME.id)
    note('Você saiu do grupo')
    return 'Você saiu do grupo.'
  }
  if (input.action === 'invite') {
    if (!admin) throw new Error(refused)
    return `https://chat.whatsapp.com/TESTE${input.contactId.slice(-6)}`
  }
  if (!admin) throw new Error(refused)
  const person = input.participantId || ''
  if (input.action === 'add') {
    if (!person) throw new Error('Escolha quem adicionar')
    if (group.members.includes(person)) throw new Error('Essa pessoa já está no grupo.')
    group.members.push(person)
    note(`Você adicionou ${nameOf(person)}`)
    return 'Pessoa adicionada ao grupo.'
  }
  if (input.action === 'remove' || input.action === 'promote' || input.action === 'demote') {
    if (!person) throw new Error('Escolha o participante')
    if (!group.members.includes(person)) throw new Error('Essa pessoa não está no grupo.')
    if (input.action === 'remove') {
      group.members = group.members.filter((id) => id !== person)
      group.admins = group.admins.filter((id) => id !== person)
      note(`Você removeu ${nameOf(person)}`)
      return 'Pessoa removida do grupo.'
    }
    if (input.action === 'promote') {
      if (!group.admins.includes(person)) group.admins.push(person)
      return 'Participante promovido a admin.'
    }
    group.admins = group.admins.filter((id) => id !== person)
    return 'Admin rebaixado.'
  }
  if (input.action === 'subject') {
    const name = input.text?.trim() || ''
    if (!name) throw new Error('Digite o nome do grupo')
    patchChat(input.contactId, { name, initials: initials(name) })
    note(`Você mudou o nome do grupo para “${name}”`)
    return 'Nome do grupo atualizado.'
  }
  if (input.action === 'description') {
    group.description = input.text?.trim() || ''
    note('Você mudou a descrição do grupo')
    return 'Descrição do grupo atualizada.'
  }
  if (!input.file?.data) throw new Error('Escolha uma foto')
  photos.set(input.contactId, asDataUrl(input.file))
  waEvents.emit('photos', [{ id: input.contactId, photo: photos.get(input.contactId)! }])
  note('Você mudou a foto do grupo')
  return 'Foto do grupo atualizada.'
}

export async function logout() {
  await destroyWhatsApp()
  chats.clear()
  messages.clear()
  photos.clear()
  // Show a QR like the real thing, then "scan" it by itself after a few seconds.
  const qr = await QRCode.toDataURL('MODO TESTE - WhatsApp de mentira', { width: 280, margin: 1 })
  setState({ status: 'qr', qr, me: null })
  later(5000, () => {
    setState({ status: 'idle', qr: null })
    void startWhatsApp()
  })
}
