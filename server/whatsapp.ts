import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import QRCode from 'qrcode'
import type { BlastProgress, ChatMessage, ChatProfile, ConnectionState, Contact, MeUser } from './types.ts'
import { clearCache, loadCache, saveCache } from './persist.ts'
import { colorFor, displayName, initials, isUsefulJid, jidPhone, renderTemplate, sleep } from './util.ts'
import { isFullMessageId, messageKey, sameMessageId, serializeMessageId, type RawMessageId } from '../src/messageIds.ts'

const require = createRequire(import.meta.url)
const { Client, LocalAuth, MessageMedia, Poll } = require('whatsapp-web.js') as {
  Client: new (opts: Record<string, unknown>) => WwebClient
  LocalAuth: new (opts: Record<string, unknown>) => unknown
  MessageMedia: new (mimetype: string, data: string, filename?: string) => {
    mimetype: string
    data: string
    filename?: string
  }
  Poll: new (pollName: string, pollOptions: string[]) => unknown
}

const AUTH_DIR = path.join(process.cwd(), 'wwebjs_auth')
const BLAST_GAP_MS = 2000
function readBrowserScript(name: string) {
  const raw = readFileSync(path.join(process.cwd(), 'server', name), 'utf8')
  if (!raw.includes(POLL_READER_SLOT)) return raw
  return raw.replace(POLL_READER_SLOT, () => pollReader())
}

const POLL_READER_SLOT = '/*__POLL_READER__*/'
/** In-page `async function pollOf(msg)`, shared by the thread scraper and the poll jobs. */
function pollReader() {
  return readFileSync(path.join(process.cwd(), 'server', 'poll-reader.browser.js'), 'utf8')
}

function chromePath() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((item): item is string => Boolean(item))
  return candidates.find((item) => existsSync(item))
}

type WwebChat = {
  id: { _serialized: string; user?: string }
  name?: string
  isGroup?: boolean
  timestamp?: number
  lastMessage?: { body?: string; timestamp?: number; id?: { id?: string }; fromMe?: boolean }
  fetchMessages: (opts: { limit: number }) => Promise<WwebMessage[]>
  sendMessage: (text: string) => Promise<WwebMessage | void>
  sendSeen?: () => Promise<unknown>
  sendStateTyping?: () => Promise<unknown>
  clearState?: () => Promise<unknown>
  addParticipants?: (ids: string[]) => Promise<unknown>
  removeParticipants?: (ids: string[]) => Promise<unknown>
  promoteParticipants?: (ids: string[]) => Promise<unknown>
  demoteParticipants?: (ids: string[]) => Promise<unknown>
  leave?: () => Promise<unknown>
  setSubject?: (subject: string) => Promise<unknown>
  setDescription?: (description: string) => Promise<unknown>
  setPicture?: (media: unknown) => Promise<unknown>
  getInviteCode?: () => Promise<string>
}

type WwebMessage = {
  id: Exclude<RawMessageId, string | null | undefined>
  from: string
  to?: string
  body?: string
  fromMe?: boolean
  timestamp?: number
  type?: string
  notifyName?: string
  pollName?: string
  pollOptions?: { name: string; localId: number }[]
  allowMultipleAnswers?: boolean
  getChat?: () => Promise<WwebChat>
  downloadMedia?: () => Promise<{ mimetype?: string; data?: string } | undefined>
}

type WwebClient = {
  initialize: () => Promise<void>
  destroy: () => Promise<void>
  logout: () => Promise<void>
  getChats: () => Promise<WwebChat[]>
  getChatById: (id: string) => Promise<WwebChat>
  getMessageById: (id: string) => Promise<WwebMessage>
  getNumberId: (number: string) => Promise<{ _serialized: string } | null>
  sendMessage: (jid: string, content: unknown, options?: Record<string, unknown>) => Promise<WwebMessage | void>
  createGroup: (
    title: string,
    participants: string[],
  ) => Promise<{ gid?: { _serialized?: string }; title?: string } | string>
  createCallLink: (date: Date, kind: 'voice' | 'video') => Promise<string | undefined>
  muteChat: (chatId: string, unmuteDate?: Date) => Promise<unknown>
  unmuteChat: (chatId: string) => Promise<unknown>
  archiveChat: (chatId: string) => Promise<boolean>
  unarchiveChat: (chatId: string) => Promise<boolean>
  pinChat: (chatId: string) => Promise<boolean>
  unpinChat: (chatId: string) => Promise<boolean>
  sendReaction: (messageId: string, reaction: string) => Promise<unknown>
  info?: { pushname?: string; wid?: { _serialized?: string; user?: string } }
  pupPage?: {
    evaluate: (fn: (() => unknown) | string) => Promise<unknown>
  }
  on: (event: string, handler: (...args: never[]) => unknown) => void
}

type ScrapedChat = {
  id: string
  name: string
  phone?: string
  isGroup: boolean
  timestamp: number
  lastBody: string
  lastFromMe: boolean
  lastId?: string
  unread?: number
  muted?: boolean
  pinned?: boolean
  archived?: boolean
}

type ScrapedMessage = {
  id: string
  from: string
  body: string
  fromMe: boolean
  timestamp: number
  kind?: ChatMessage['kind']
  media?: string
  authorId?: string
  authorName?: string
  duration?: number
  quote?: { id: string; text: string }
  ack?: number
  starred?: boolean
  pinned?: boolean
  gif?: boolean
  reactions?: ChatMessage['reactions']
  poll?: ChatMessage['poll']
  filename?: string
}

const chats = new Map<string, Contact>()
const messages = new Map<string, ChatMessage[]>()
const photos = new Map<string, string>()
const photoQueued = new Set<string>()
const photoQueue: string[] = []
let photoPumping = false

let client: WwebClient | null = null
let starting = false
let blasting = false
let persistTimer: ReturnType<typeof setTimeout> | undefined
let watchId = ''
let presenceTimer: ReturnType<typeof setInterval> | undefined
let lastPresence = ''

export const waEvents = new EventEmitter()

let state: ConnectionState = {
  status: 'idle',
  qr: null,
  me: null,
}

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

function enqueuePhotos(ids: string[], priority = false) {
  if (!client?.pupPage) return
  const fresh: string[] = []
  for (const id of ids) {
    if (!id || photos.has(id)) continue
    if (!photoQueued.has(id)) {
      photoQueued.add(id)
      fresh.push(id)
      continue
    }
    if (!priority) continue
    const at = photoQueue.indexOf(id)
    if (at > 0) {
      photoQueue.splice(at, 1)
      photoQueue.unshift(id)
    }
  }
  if (priority) photoQueue.unshift(...fresh)
  else photoQueue.push(...fresh)
  void pumpPhotos()
}

async function pumpPhotos() {
  if (photoPumping) return
  photoPumping = true
  try {
    while (photoQueue.length && client?.pupPage && state.status === 'ready') {
      const slice = photoQueue.splice(0, 8)
      const cached = await scrapePhotos(slice, true)
      rememberPhotos(cached)
      const found = new Set(cached.map((row) => row.id))
      const missing = slice.filter((id) => !found.has(id))
      if (missing.length) {
        const loaded = await scrapePhotos(missing, false)
        rememberPhotos(loaded)
        await sleep(120)
      }
    }
  } catch (error) {
    console.warn('[zap] fotos', error instanceof Error ? error.message : error)
  } finally {
    photoPumping = false
    if (photoQueue.length && state.status === 'ready') void pumpPhotos()
  }
}

function rememberPhotos(rows: { id: string; photo: string }[]) {
  const fresh = rows.filter((row) => row.photo && photos.get(row.id) !== row.photo)
  if (!fresh.length) return
  for (const row of fresh) photos.set(row.id, row.photo)
  console.log('[zap] fotos de perfil', fresh.length, 'total', photos.size)
  waEvents.emit('photos', fresh)
}

async function scrapePhotos(ids: string[], cachedOnly: boolean) {
  if (!client?.pupPage || !ids.length) return [] as { id: string; photo: string }[]
  const script = readBrowserScript('scrape-photos.browser.js')
    .replace('__IDS__', JSON.stringify(ids))
    .replace('__CACHED__', cachedOnly ? 'true' : 'false')
  try {
    const rows = (await client.pupPage.evaluate(script)) as { id?: string; photo?: string }[]
    return (Array.isArray(rows) ? rows : [])
      .filter((row) => row?.id && row.photo)
      .map((row) => ({ id: String(row.id), photo: String(row.photo) }))
  } catch (error) {
    console.warn('[zap] lote de fotos falhou', error instanceof Error ? error.message : error)
    return []
  }
}

/**
 * Current WhatsApp Web removed `_serialized` from message keys (the full id is now only
 * `key.toString()`), but whatsapp-web.js still reads `id._serialized` in many places — e.g.
 * sendMessage and editMessage return `Msg.get(key._serialized)`, which made every send return
 * nothing. Adding `_serialized` back as a getter restores those code paths. Safe to run repeatedly.
 */
const PATCH_MSG_KEY = `(function () {
  try {
    var MsgKey = window.require('WAWebMsgKey')
    var proto = MsgKey && MsgKey.prototype
    if (proto && !Object.prototype.hasOwnProperty.call(proto, '_serialized')) {
      Object.defineProperty(proto, '_serialized', {
        configurable: true,
        get: function () { return this.toString() },
      })
    }
    return true
  } catch (error) {
    return false
  }
})()`

async function patchMessageKeys() {
  try {
    const ok = await client?.pupPage?.evaluate(PATCH_MSG_KEY)
    if (!ok) console.warn('[zap] não deu para corrigir os ids de mensagem do WhatsApp Web')
  } catch (error) {
    console.warn('[zap] patch de ids', error instanceof Error ? error.message.split('\n')[0] : error)
  }
}

function setState(patch: Partial<ConnectionState>) {
  state = { ...state, ...patch }
  waEvents.emit('state', state)
}

function schedulePersist() {
  clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    try {
      saveCache(listChats(), messages)
    } catch (error) {
      console.warn('[zap] cache', error instanceof Error ? error.message : error)
    }
  }, 800)
}

export function hydrateCache() {
  const cached = loadCache()
  if (!cached) return
  for (const chat of cached.chats) {
    if (!chat?.id) continue
    chats.set(chat.id, { ...chat, typing: '' })
  }
  for (const [id, list] of Object.entries(cached.messages)) {
    if (Array.isArray(list)) messages.set(id, collapseMessages(list))
  }
}

function upsertChat(partial: Partial<Contact> & { id: string }) {
  const current = chats.get(partial.id)
  const name = displayName(partial.id, partial.name || current?.name)
  const next: Contact = {
    id: partial.id,
    name,
    phone: partial.phone ?? current?.phone ?? jidPhone(partial.id),
    initials: initials(name),
    color: current?.color ?? colorFor(partial.id),
    lastSeen: partial.lastSeen ?? current?.lastSeen ?? (partial.isGroup || current?.isGroup ? 'grupo' : ''),
    online: partial.online ?? current?.online,
    lastAt: Math.max(partial.lastAt ?? 0, current?.lastAt ?? 0),
    isGroup: partial.isGroup ?? current?.isGroup ?? partial.id.includes('@g.us'),
    unread: partial.unread ?? current?.unread ?? 0,
    muted: partial.muted ?? current?.muted ?? false,
    pinned: partial.pinned ?? current?.pinned ?? false,
    archived: partial.archived ?? current?.archived ?? false,
    typing: partial.typing !== undefined ? partial.typing : current?.typing,
  }
  chats.set(partial.id, next)
  emitChatsSoon()
  schedulePersist()
}

let chatsTimer: ReturnType<typeof setTimeout> | undefined
function emitChatsSoon() {
  clearTimeout(chatsTimer)
  chatsTimer = setTimeout(() => waEvents.emit('chats', listChats()), 150)
}

function fromWwebMessage(
  msg: WwebMessage,
  chatId?: string,
  extra?: {
    kind?: ChatMessage['kind']
    media?: string
    authorId?: string
    authorName?: string
    duration?: number
    quote?: { id: string; text: string }
    ack?: number
    starred?: boolean
    pinned?: boolean
    gif?: boolean
    reactions?: ChatMessage['reactions']
    poll?: ChatMessage['poll']
    filename?: string
  },
): ChatMessage | null {
  const contactId = chatId || (msg.fromMe ? msg.to : msg.from)
  if (!contactId || !isUsefulJid(contactId)) return null
  const rawBody = (msg.body || '').trim()
  const raw = rawBody.length > 64 && (/^\/9j\//.test(rawBody) || /^iVBOR/.test(rawBody) || /^UklGR/.test(rawBody) || /^R0lGOD/.test(rawBody))
    ? ''
    : rawBody
  const labelKind: ChatMessage['kind'] | undefined =
    raw === 'Foto'
      ? 'image'
      : raw === 'Áudio'
        ? 'audio'
        : raw === 'Vídeo'
          ? 'video'
          : raw === 'Figurinha'
            ? 'sticker'
            : undefined
  const kind: ChatMessage['kind'] =
    extra?.kind ||
    labelKind ||
    (msg.type === 'sticker'
      ? 'sticker'
      : msg.type === 'image'
        ? 'image'
        : msg.type === 'video'
          ? 'video'
          : msg.type === 'audio' || msg.type === 'ptt'
            ? 'audio'
            : msg.type === 'document'
              ? 'document'
              : 'text')
  const media = extra?.media || ''
  const text =
    raw === 'Foto' || raw === 'Áudio' || raw === 'Vídeo' || raw === 'Figurinha' || raw === 'Documento'
      ? ''
      : raw
  if (!text && !media && kind === 'text') return null
  const ack = extra?.ack ?? 0
  const fromMe = Boolean(msg.fromMe)
  const status: ChatMessage['status'] = !fromMe ? 'read' : ack >= 3 ? 'read' : ack >= 2 ? 'delivered' : 'sent'
  return {
    id: serializeMessageId(msg.id) || `${contactId}-${msg.timestamp}`,
    contactId,
    text: text || extra?.filename || '',
    fromMe,
    at: Number(msg.timestamp || 0) * 1000 || Date.now(),
    status,
    kind,
    media: media || undefined,
    authorId: extra?.authorId || undefined,
    authorName: extra?.authorName || undefined,
    duration: extra?.duration || undefined,
    quote: extra?.quote,
    starred: extra?.starred,
    pinned: extra?.pinned,
    gif: extra?.gif || msg.type === 'gif' || undefined,
    reactions: extra?.reactions?.length ? extra.reactions : undefined,
    poll: extra?.poll,
    filename: extra?.filename || undefined,
  }
}

function sameSend(a: ChatMessage, b: ChatMessage) {
  if (a.contactId !== b.contactId) return false
  if (a.id === b.id) return true
  // 13-digit ids are local placeholders (Date.now()), matched by text below instead.
  if (!/^\d{13}$/.test(messageKey(a.id)) && sameMessageId(a.id, b.id)) return true
  const echo = /^\d{13}$/.test(a.id) || /^\d{13}$/.test(b.id)
  return echo && a.fromMe && b.fromMe && a.text === b.text && Math.abs(a.at - b.at) < 8000
}

function preferId(current: string, incoming: string) {
  if (/^\d{13}$/.test(current)) return incoming
  if (/^\d{13}$/.test(incoming)) return current
  if (isFullMessageId(incoming) && !isFullMessageId(current)) return incoming
  return current
}

function collapseMessages(list: ChatMessage[]) {
  const out: ChatMessage[] = []
  for (const message of list) {
    const index = out.findIndex((item) => sameSend(item, message))
    if (index < 0) {
      if (/^\d{13}$/.test(message.id)) continue
      out.push(message)
      continue
    }
    const existing = out[index]!
    out[index] = {
      ...existing,
      ...message,
      id: preferId(existing.id, message.id),
      media: message.media || existing.media,
      quote: message.quote || existing.quote,
      at: /^\d{13}$/.test(message.id) ? existing.at : message.at || existing.at,
    }
  }
  return out
}

function patchMessage(contactId: string, id: string, patch: Partial<ChatMessage>) {
  const list = messages.get(contactId) ?? []
  const current = list.find((item) => item.id === id) ?? list.find((item) => sameMessageId(item.id, id))
  if (!current) return
  const next = { ...current, ...patch, id: preferId(current.id, id) }
  messages.set(
    contactId,
    list.map((item) => (item === current ? next : item)),
  )
  waEvents.emit('message', next)
}

function pushMessage(message: ChatMessage, emit = true) {
  const list = messages.get(message.contactId) ?? []
  const index = list.findIndex((item) => sameSend(item, message))
  if (index >= 0) {
    const existing = list[index]!
    const next = {
      ...existing,
      ...message,
      id: preferId(existing.id, message.id),
      media: message.media || existing.media,
      quote: message.quote || existing.quote,
      // Partial copies (chat-list previews) carry no poll/reactions; don't let them wipe the real ones.
      poll: message.poll ?? existing.poll,
      reactions: message.reactions ?? existing.reactions,
      at: /^\d{13}$/.test(message.id) ? existing.at : message.at || existing.at,
    }
    const changed =
      next.id !== existing.id ||
      next.status !== existing.status ||
      next.media !== existing.media ||
      next.text !== existing.text ||
      JSON.stringify(next.poll) !== JSON.stringify(existing.poll) ||
      JSON.stringify(next.reactions) !== JSON.stringify(existing.reactions)
    if (!changed) return
    const copy = [...list]
    copy[index] = next
    messages.set(message.contactId, copy)
    if (emit) waEvents.emit('message', next)
    return
  }
  if (/^\d{13}$/.test(message.id)) return
  messages.set(message.contactId, [...list, message].sort((a, b) => a.at - b.at).slice(-400))
  const unread = !message.fromMe && emit ? (chats.get(message.contactId)?.unread ?? 0) + 1 : undefined
  upsertChat({ id: message.contactId, lastAt: message.at, unread })
  if (emit) waEvents.emit('message', message)
}

function ingestChat(
  chat: WwebChat & { unread?: number; muted?: boolean; pinned?: boolean; archived?: boolean },
  phone = '',
) {
  const id = chat.id?._serialized
  if (!isUsefulJid(id)) return
  upsertChat({
    id,
    name: chat.name,
    phone: phone ? `+${phone.replace(/^\+/, '')}` : undefined,
    isGroup: Boolean(chat.isGroup),
    lastAt: Number(chat.timestamp || chat.lastMessage?.timestamp || 0) * 1000,
    unread: chat.unread,
    muted: chat.muted,
    pinned: chat.pinned,
    archived: chat.archived,
  })
  if (chat.lastMessage?.body) {
    const last = fromWwebMessage(
      {
        id: { id: chat.lastMessage.id?.id },
        from: id,
        body: chat.lastMessage.body,
        fromMe: chat.lastMessage.fromMe,
        timestamp: chat.lastMessage.timestamp,
      },
      id,
    )
    if (last) pushMessage(last, false)
  }
}

async function killOrphanChrome() {
  if (process.platform !== 'win32') return
  await new Promise<void>((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" | Where-Object { $_.CommandLine -match 'wwebjs_auth' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { windowsHide: true },
      () => resolve(),
    )
  })
  await sleep(1200)
}

async function scrapeChats(): Promise<ScrapedChat[]> {
  if (!client?.pupPage) return []
  const result = await client.pupPage.evaluate(readBrowserScript('scrape-chats.browser.js'))
  return Array.isArray(result) ? (result as ScrapedChat[]) : []
}

async function scrapeThread(contactId: string, beforeTs = 0): Promise<ScrapedMessage[]> {
  if (!client?.pupPage) return []
  const script = readBrowserScript('scrape-thread.browser.js')
    .replace('"__CHAT_ID__"', JSON.stringify(contactId))
    .replace('__BEFORE_TS__', String(beforeTs || 0))
  const result = await client.pupPage.evaluate(script)
  return Array.isArray(result) ? (result as ScrapedMessage[]) : []
}

export async function destroyWhatsApp() {
  try {
    await client?.destroy()
  } catch {
    /* ignore */
  }
  client = null
  starting = false
}

async function syncChats() {
  if (!client) return
  let lastError: unknown
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      if (attempt > 1) await sleep(3000)
      const scraped = await scrapeChats()
      if (!scraped.length) throw new Error('Store.Chat ainda vazia')
      console.log('[zap] chats do WhatsApp Web:', scraped.length)
      for (const chat of scraped) {
        ingestChat(
          {
            id: { _serialized: chat.id, user: chat.id.split('@')[0] },
            name: chat.name,
            isGroup: chat.isGroup,
            timestamp: chat.timestamp,
            lastMessage: chat.lastBody
              ? {
                  body: chat.lastBody,
                  timestamp: chat.timestamp,
                  fromMe: chat.lastFromMe,
                  id: { id: chat.lastId || `${chat.id}-last` },
                }
              : undefined,
            fetchMessages: async () => [],
            sendMessage: async () => undefined,
            unread: chat.unread,
            muted: chat.muted,
            pinned: chat.pinned,
            archived: chat.archived,
          },
          chat.phone,
        )
      }
      waEvents.emit('messages-sync')
      enqueuePhotos([...chats.keys(), state.me?.id || ''])
      return
    } catch (error) {
      lastError = error
      console.warn(`[zap] sync tentativa ${attempt}/6 falhou`, error instanceof Error ? error.message : error)
    }
  }
  console.warn('[zap] não deu pra listar as conversas ainda', lastError)
}

export async function loadThread(contactId: string) {
  if (!client || state.status !== 'ready') return listMessages(contactId)
  try {
    const history = await scrapeThread(contactId)
    const kinds = history.reduce<Record<string, number>>((acc, msg) => {
      const kind = msg.kind || 'text'
      acc[kind] = (acc[kind] || 0) + 1
      return acc
    }, {})
    console.log('[zap] thread', contactId, kinds)
    const mediaDebug = history
      .filter((msg) => msg.kind === 'sticker' || msg.kind === 'image')
      .map((msg) => ({
        kind: msg.kind,
        hasMedia: Boolean(msg.media),
        error: (msg as ScrapedMessage & { mediaError?: string }).mediaError,
      }))
    if (mediaDebug.length) console.log('[zap] media', mediaDebug)
    const stickers = history.filter((msg) => msg.kind === 'sticker' && msg.media).length
    if (stickers) console.log('[zap] figurinhas na conversa', contactId, stickers)
    for (const msg of history) {
      const stored = fromWwebMessage(
        {
          id: { _serialized: msg.id, id: msg.id },
          from: msg.fromMe ? state.me?.id || contactId : contactId,
          to: contactId,
          body: msg.body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          type: msg.kind === 'text' ? 'chat' : msg.kind,
        },
        contactId,
        { kind: msg.kind, media: msg.media, authorId: msg.authorId, authorName: msg.authorName, duration: msg.duration, quote: msg.quote, ack: msg.ack, starred: msg.starred, pinned: msg.pinned, gif: msg.gif, reactions: msg.reactions, poll: msg.poll, filename: msg.filename },
      )
      if (stored) pushMessage(stored, false)
    }
    dropStaleOwnMessages(contactId, history)
    waEvents.emit('messages-sync')
  } catch (error) {
    console.warn('[zap] falha ao carregar conversa', contactId, error)
  }
  return listMessages(contactId)
}

/**
 * Drops stale copies of our own messages: upload placeholders ("…create…" ids) and "-last"
 * previews that WhatsApp Web doesn't list in the range it just returned. Real messages with a
 * normal id are never dropped here, even if the scraper skipped them (e.g. a type it can't show).
 * Very recent sends are kept in case WhatsApp hasn't listed them yet.
 */
function dropStaleOwnMessages(contactId: string, history: ScrapedMessage[]) {
  const stamps = history.map((msg) => Number(msg.timestamp || 0)).filter(Boolean)
  if (!stamps.length) return
  const from = Math.min(...stamps) * 1000
  const keys = new Set(history.map((msg) => messageKey(msg.id)))
  const placeholder = (id: string) => /create/i.test(messageKey(id)) || id.endsWith('-last')
  const list = messages.get(contactId) ?? []
  const kept = list.filter(
    (item) =>
      !(
        item.fromMe &&
        placeholder(item.id) &&
        item.at >= from &&
        !keys.has(messageKey(item.id)) &&
        Date.now() - item.at > 15_000
      ),
  )
  if (kept.length === list.length) return
  console.log('[zap] cópias antigas removidas', contactId, list.length - kept.length)
  messages.set(contactId, kept)
  schedulePersist()
}

export async function loadEarlier(contactId: string, beforeMs: number) {
  if (!client || state.status !== 'ready') return listMessages(contactId)
  const beforeTs = Math.floor(beforeMs / 1000)
  const history = await scrapeThread(contactId, beforeTs)
  console.log('[zap] anteriores', contactId, history.length)
  for (const msg of history) {
    const stored = fromWwebMessage(
      {
        id: { _serialized: msg.id, id: msg.id },
        from: msg.fromMe ? state.me?.id || contactId : contactId,
        to: contactId,
        body: msg.body,
        fromMe: msg.fromMe,
        timestamp: msg.timestamp,
        type: msg.kind === 'text' ? 'chat' : msg.kind,
      },
      contactId,
      { kind: msg.kind, media: msg.media, authorId: msg.authorId, authorName: msg.authorName, duration: msg.duration, quote: msg.quote, ack: msg.ack, starred: msg.starred, reactions: msg.reactions, poll: msg.poll, filename: msg.filename },
    )
    if (stored) pushMessage(stored, false)
  }
  const list = listMessages(contactId)
  waEvents.emit('thread', { contactId, messages: list })
  return list
}

const emptyProfile = (): ChatProfile => ({
  description: '',
  phone: '',
  muted: false,
  disappearing: 'Desligadas',
  media: 0,
  links: 0,
  docs: 0,
  starred: 0,
  participants: [],
  commonGroups: [],
  mediaItems: [],
  linkItems: [],
  docItems: [],
  starredItems: [],
})

export async function loadProfile(contactId: string) {
  if (!client?.pupPage || state.status !== 'ready' || !contactId) return emptyProfile()
  const script = readBrowserScript('scrape-profile.browser.js').replace('"__CHAT_ID__"', JSON.stringify(contactId))
  const result = (await client.pupPage.evaluate(script)) as Partial<ChatProfile>
  const participants = Array.isArray(result?.participants) ? result.participants : []
  const commonGroups = Array.isArray(result?.commonGroups) ? result.commonGroups : []
  console.log('[zap] dados', contactId, 'pessoas', participants.length, 'grupos', commonGroups.length)
  enqueuePhotos(
    [contactId, ...participants.map((person) => person.id), ...commonGroups.map((group) => group.id)],
    true,
  )
  return {
    ...emptyProfile(),
    ...result,
    participants,
    commonGroups,
    mediaItems: Array.isArray(result?.mediaItems) ? result.mediaItems : [],
    linkItems: Array.isArray(result?.linkItems) ? result.linkItems : [],
    docItems: Array.isArray(result?.docItems) ? result.docItems : [],
    starredItems: Array.isArray(result?.starredItems) ? result.starredItems : [],
  }
}

export async function startWhatsApp() {
  if (starting || client) return
  starting = true
  setState({ status: 'connecting', qr: null })
  try {
    await killOrphanChrome()
    const next = new Client({
      authStrategy: new LocalAuth({ dataPath: AUTH_DIR }),
      puppeteer: {
        headless: true,
        executablePath: chromePath(),
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          '--autoplay-policy=no-user-gesture-required',
        ],
      },
    })

    next.on('qr', ((qr: string) => {
      void QRCode.toDataURL(qr, { width: 280, margin: 1 }).then((dataUrl) => {
        console.log('[zap] QR do WhatsApp Web gerado')
        setState({ status: 'qr', qr: dataUrl })
      })
    }) as (...args: never[]) => unknown)

    next.on('ready', (() => {
      void (async () => {
        try {
          const name = next.info?.pushname || 'Você'
          const me: MeUser = {
            id: next.info?.wid?._serialized || '',
            name,
            initials: initials(name),
          }
          console.log('[zap] WhatsApp Web pronto', me.id)
          await patchMessageKeys()
          setState({ status: 'ready', qr: null, me })
          await sleep(2500)
          await syncChats()
        } catch (error) {
          console.warn('[zap] erro depois do ready', error)
        }
      })()
    }) as (...args: never[]) => unknown)

    next.on('authenticated', (() => {
      console.log('[zap] autenticado no WhatsApp Web')
      setState({ status: 'connecting', qr: null })
    }) as (...args: never[]) => unknown)

    next.on('auth_failure', ((message: string) => {
      console.error('[zap] falha de auth', message)
      setState({ status: 'offline', qr: null })
    }) as (...args: never[]) => unknown)

    next.on('disconnected', ((reason: string) => {
      console.log('[zap] desconectou', reason)
      client = null
      setState({ status: 'offline', qr: null })
      setTimeout(() => {
        startWhatsApp()
      }, 3000)
    }) as (...args: never[]) => unknown)

    next.on('message_ack', ((msg: WwebMessage, ack: number) => {
      const contactId = msg.fromMe ? msg.to : msg.from
      const id = serializeMessageId(msg.id)
      if (!contactId || !id) return
      const status: ChatMessage['status'] = ack >= 3 ? 'read' : ack >= 2 ? 'delivered' : 'sent'
      patchMessage(contactId, id, { status })
    }) as (...args: never[]) => unknown)

    next.on('message_reaction', ((reaction: {
      msgId?: RawMessageId & { remote?: { _serialized?: string; $1?: string } | string }
      reaction?: string
      senderId?: string | { _serialized?: string }
      id?: { fromMe?: boolean }
    }) => {
      const messageId = serializeMessageId(reaction.msgId)
      const remote = typeof reaction.msgId === 'object' && reaction.msgId ? reaction.msgId.remote : undefined
      let contactId = typeof remote === 'string' ? remote : remote?._serialized || remote?.$1
      if (!messageId) return
      const has = (list: ChatMessage[]) => list.some((item) => sameMessageId(item.id, messageId))
      if (!contactId || !has(messages.get(contactId) ?? [])) {
        for (const [id, list] of messages) {
          if (has(list)) contactId = id
        }
      }
      if (!contactId) return
      const current = (messages.get(contactId) ?? []).find((item) => sameMessageId(item.id, messageId))
      const sender = reaction.senderId
      const author = typeof sender === 'string' ? sender : sender?._serialized || ''
      const fromMe = Boolean(reaction.id?.fromMe)
      const nextReactions = (current?.reactions ?? []).filter((item) => item.author !== author || item.fromMe !== fromMe)
      if (reaction.reaction) nextReactions.push({ emoji: reaction.reaction, fromMe, author })
      patchMessage(contactId, messageId, { reactions: nextReactions })
    }) as (...args: never[]) => unknown)

    next.on('vote_update', ((vote: { parentMessage?: { id?: RawMessageId }; parentMsgKey?: RawMessageId }) => {
      // Someone (you included, from the phone) voted: re-read the whole poll so counts stay exact.
      const parentId = serializeMessageId(vote.parentMessage?.id) || serializeMessageId(vote.parentMsgKey)
      if (parentId) void refreshPoll(parentId)
    }) as (...args: never[]) => unknown)

    next.on('message_create', ((msg: WwebMessage) => {
      // While a photo/video uploads, WhatsApp Web briefly creates a placeholder message whose key
      // contains "create". The real message follows with its own id, so skip the placeholder
      // (it used to show up as a second "Baixar foto" bubble).
      if (/create/i.test(messageKey(serializeMessageId(msg.id)))) return
      void (async () => {
        const extra: { kind?: ChatMessage['kind']; media?: string; gif?: boolean; poll?: ChatMessage['poll'] } = {}
        if (msg.type === 'poll_creation') {
          // A brand-new poll has no votes yet; later votes arrive through 'vote_update'.
          extra.poll = {
            name: msg.pollName || '',
            multi: Boolean(msg.allowMultipleAnswers),
            options: (msg.pollOptions ?? []).map((option) => ({
              id: Number(option.localId),
              name: option.name,
              votes: 0,
              voters: [],
              mine: false,
            })),
            voters: 0,
          }
          msg = { ...msg, body: `📊 ${msg.pollName || 'Enquete'}` }
        }
        if (msg.type === 'gif') {
          extra.kind = 'video'
          extra.gif = true
        }
        if (msg.type === 'sticker' || msg.type === 'image' || msg.type === 'video' || msg.type === 'gif' || msg.type === 'audio' || msg.type === 'ptt') {
          extra.kind = extra.kind || (msg.type === 'ptt' ? 'audio' : msg.type === 'gif' ? 'video' : msg.type)
          try {
            const file = await msg.downloadMedia?.()
            if (file?.data) {
              extra.media = `data:${file.mimetype || 'image/webp'};base64,${file.data}`
            }
            if (!extra.media) {
              const id = serializeMessageId(msg.id)
              const contactId = msg.fromMe ? msg.to : msg.from
              if (id && contactId) extra.media = await downloadInPage(contactId, id)
            }
          } catch {
            /* ignore */
          }
        }
        const stored = fromWwebMessage(msg, undefined, extra)
        if (stored) pushMessage(stored)
      })()
    }) as (...args: never[]) => unknown)

    client = next
    await next.initialize()
  } catch (error) {
    console.error('Falha ao iniciar WhatsApp Web', error)
    try {
      await client?.destroy()
    } catch {
      /* ignore */
    }
    client = null
    setState({ status: 'offline', qr: null })
    setTimeout(() => startWhatsApp(), 8000)
  } finally {
    starting = false
  }
}

function sentMessageId(sent: WwebMessage | void) {
  return sent && 'id' in sent ? serializeMessageId(sent.id) : ''
}

export async function sendText(
  jid: string,
  text: string,
  viaBlast = false,
  quoted?: { id: string; text: string },
  mentions: string[] = [],
) {
  if (!client || state.status !== 'ready') throw new Error('WhatsApp não está conectado')
  if (!isUsefulJid(jid)) throw new Error('Contato inválido')
  if (!text.trim()) throw new Error('Mensagem vazia: nada foi enviado')
  const sent = await client.sendMessage(jid, text, {
    quotedMessageId: quoted?.id,
    mentions: mentions.length ? mentions : undefined,
  })
  const id = sentMessageId(sent)
  if (!id) return null
  const stored: ChatMessage = {
    id,
    contactId: jid,
    text,
    fromMe: true,
    at: Date.now(),
    viaBlast,
    status: 'sent',
    quote: quoted,
  }
  pushMessage(stored)
  return stored
}

export async function sendChatFile(
  jid: string,
  file: CommandFile,
  kind: 'photo' | 'audio' | 'video' | 'document' | 'sticker' | 'gif',
  caption = '',
) {
  if (!client || state.status !== 'ready') throw new Error('WhatsApp não está conectado')
  if (!isUsefulJid(jid)) throw new Error('Contato inválido')
  if (!file?.data) throw new Error('Anexe um arquivo')
  const media = new MessageMedia(
    file.mimetype ||
      (kind === 'audio'
        ? 'audio/ogg; codecs=opus'
        : kind === 'video' || kind === 'gif'
          ? 'video/mp4'
          : kind === 'sticker'
            ? 'image/webp'
            : kind === 'document'
              ? 'application/octet-stream'
              : 'image/jpeg'),
    asBase64(file.data),
    file.name || 'arquivo',
  )
  const sent = await client.sendMessage(jid, media, {
    caption: caption.trim() || undefined,
    sendAudioAsVoice: kind === 'audio',
    sendMediaAsDocument: kind === 'document',
    sendMediaAsSticker: kind === 'sticker',
    sendVideoAsGif: kind === 'gif',
  })
  const id = sentMessageId(sent)
  if (!id) return null
  const stored: ChatMessage = {
    id,
    contactId: jid,
    text: caption.trim() || (kind === 'document' ? file.name : ''),
    fromMe: true,
    at: Date.now(),
    status: 'sent',
    kind: kind === 'photo' ? 'image' : kind === 'gif' ? 'video' : kind === 'document' ? 'document' : kind,
    media: `data:${media.mimetype};base64,${media.data}`,
  }
  pushMessage(stored)
  return stored
}

export async function sendBlast(contactIds: string[], template: string) {
  if (blasting) throw new Error('Já tem um disparo em andamento')
  if (!client || state.status !== 'ready') throw new Error('WhatsApp não está conectado')
  blasting = true
  const unique = [...new Set(contactIds)].filter(isUsefulJid)
  const results: BlastProgress[] = []
  try {
    for (let index = 0; index < unique.length; index++) {
      if (index > 0) await sleep(BLAST_GAP_MS)
      const contactId = unique[index]!
      const contact = chats.get(contactId) ?? { id: contactId, name: displayName(contactId) }
      const text = renderTemplate(template, contact)
      try {
        // "via disparo" only marks real bulk sends (more than one person).
        await sendText(contactId, text, unique.length > 1)
        const progress: BlastProgress = {
          contactId,
          name: contact.name,
          ok: true,
          index: index + 1,
          total: unique.length,
        }
        results.push(progress)
        waEvents.emit('blast:progress', progress)
      } catch (error) {
        const progress: BlastProgress = {
          contactId,
          name: contact.name,
          ok: false,
          error: error instanceof Error ? error.message : 'Falha ao enviar',
          index: index + 1,
          total: unique.length,
        }
        results.push(progress)
        waEvents.emit('blast:progress', progress)
      }
    }
  } finally {
    blasting = false
  }
  return {
    sent: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  }
}

export type CommandAction =
  | 'text'
  | 'photo'
  | 'audio'
  | 'group'
  | 'mute'
  | 'unmute'
  | 'disappearing'
  | 'block'
  | 'unblock'
  | 'archive'
  | 'unarchive'
  | 'pin'
  | 'unpin'
  | 'call'
  | 'reply'
  | 'react'
  | 'delete'
  | 'label'
  | 'forward'
  | 'star'
  | 'unstar'
  | 'edit'
  | 'pinmsg'
  | 'unpinmsg'
  | 'unread'
  | 'clear'
  | 'document'
  | 'contact'
  | 'poll'
  | 'sticker'
  | 'gif'
  | 'video'

export type CommandFile = {
  name: string
  mimetype: string
  data: string
}

function asBase64(data: string) {
  const marker = 'base64,'
  const index = data.indexOf(marker)
  return index >= 0 ? data.slice(index + marker.length) : data
}

function peopleOnly(ids: string[]) {
  return [...new Set(ids)].filter((id) => isUsefulJid(id) && !id.includes('@g.us'))
}

export async function sendMediaBlast(
  contactIds: string[],
  file: CommandFile,
  caption = '',
  kind: 'photo' | 'audio' = 'photo',
) {
  if (blasting) throw new Error('Já tem um disparo em andamento')
  if (!client || state.status !== 'ready') throw new Error('WhatsApp não está conectado')
  if (!file?.data) throw new Error('Anexe um arquivo')
  const unique = [...new Set(contactIds)].filter(isUsefulJid)
  if (!unique.length) throw new Error('Selecione pelo menos um contato')
  const media = new MessageMedia(
    file.mimetype || (kind === 'audio' ? 'audio/ogg; codecs=opus' : 'image/jpeg'),
    asBase64(file.data),
    file.name || (kind === 'audio' ? 'audio.ogg' : 'foto.jpg'),
  )
  blasting = true
  const results: BlastProgress[] = []
  try {
    for (let index = 0; index < unique.length; index++) {
      if (index > 0) await sleep(BLAST_GAP_MS)
      const contactId = unique[index]!
      const contact = chats.get(contactId) ?? { id: contactId, name: displayName(contactId) }
      try {
        const sent = await client.sendMessage(contactId, media, {
          caption: caption.trim() || undefined,
          sendAudioAsVoice: kind === 'audio',
        })
        const id = sentMessageId(sent)
        if (id) pushMessage({
          id,
          contactId,
          text: caption.trim(),
          fromMe: true,
          at: Date.now(),
          viaBlast: true,
          status: 'sent',
          kind: kind === 'audio' ? 'audio' : 'image',
          media: `data:${media.mimetype};base64,${media.data}`,
        })
        const progress: BlastProgress = {
          contactId,
          name: contact.name,
          ok: true,
          index: index + 1,
          total: unique.length,
        }
        results.push(progress)
        waEvents.emit('blast:progress', progress)
      } catch (error) {
        const progress: BlastProgress = {
          contactId,
          name: contact.name,
          ok: false,
          error: error instanceof Error ? error.message : 'Falha ao enviar',
          index: index + 1,
          total: unique.length,
        }
        results.push(progress)
        waEvents.emit('blast:progress', progress)
      }
    }
  } finally {
    blasting = false
  }
  return {
    sent: results.filter((item) => item.ok).length,
    failed: results.filter((item) => !item.ok).length,
    results,
  }
}

function phoneJidFor(id: string) {
  if (id.endsWith('@c.us') || id.endsWith('@s.whatsapp.net')) return id
  const digits = (chats.get(id)?.phone || '').replace(/\D/g, '')
  if (digits.length >= 8) return `${digits}@c.us`
  return id
}

export async function createGroupCommand(contactIds: string[], title: string) {
  if (!client?.pupPage || state.status !== 'ready') throw new Error('WhatsApp não está conectado')
  const name = title.replace(/^(criar grupo|novo grupo|\/grupo)\s*/i, '').trim()
  if (!name) throw new Error('Digite o nome do grupo')
  const participants = [...new Set(peopleOnly(contactIds).map(phoneJidFor))]
  if (!participants.length) throw new Error('Marque pelo menos um contato com @')
  const script = `(async function(){
    var title = ${JSON.stringify(name)};
    var participants = ${JSON.stringify(participants)};
    function widOf(value) {
      return window.require('WAWebWidFactory').createWid(value);
    }
    var wids = [];
    for (var i = 0; i < participants.length; i++) {
      try {
        var raw = String(participants[i]);
        var wid = widOf(raw);
        if (raw.indexOf('@lid') !== -1) {
          var phone = window.require('WAWebApiContact').getPhoneNumber(wid);
          var serialized = phone && (phone._serialized || (phone.user ? phone.user + '@c.us' : ''));
          if (serialized) wid = widOf(serialized);
        }
        var exists = await window.require('WAWebQueryExistsJob').queryWidExists(wid);
        if (exists && exists.wid) wids.push(exists.wid);
      } catch (ignored) {}
    }
    if (!wids.length) return { error: 'Não achei o número de quem entra no grupo.' };
    function findCreateGroup() {
      try {
        var named = window.require('WAWebGroupCreateJob');
        if (named && named.createGroup) return named.createGroup;
      } catch (ignored) {}
      return null;
    }
    var loadable = window.require('WAWebNewGroupFlowLoadable');
    if (loadable && loadable.requireBundle) await loadable.requireBundle();
    var createGroup = findCreateGroup();
    if (!createGroup) return { error: 'O WhatsApp mudou a função de criar grupo.' };
    var attempts = [
      wids.map(function(wid){ return { phoneNumber: wid }; }),
      wids
    ];
    var last = 'Não deu para criar o grupo.';
    for (var attempt = 0; attempt < attempts.length; attempt++) {
      try {
        var created = await createGroup({
          title: title,
          // Same defaults as whatsapp-web.js: everyone can send messages and edit the group info.
          announce: false,
          restrict: false,
          ephemeralDuration: 0,
          memberAddMode: false,
          membershipApprovalMode: false
        }, attempts[attempt]);
        var gid = created && created.wid && (created.wid._serialized || created.wid.toString());
        if (!gid) {
          last = 'O WhatsApp não devolveu o grupo.';
          continue;
        }
        return { gid: gid, title: (created && (created.subject || created.title)) || title, added: wids.length };
      } catch (error) {
        last = String((error && (error.message || error)) || last);
      }
    }
    return { error: last };
  })()`
  const result = (await client.pupPage.evaluate(script)) as { gid?: string; title?: string; added?: number; error?: string }
  if (!result || result.error || !result.gid) {
    const detail = result?.error || 'Não deu para criar o grupo.'
    console.warn('[zap] criar grupo', detail)
    throw new Error(
      detail.includes('unknown error')
        ? 'O WhatsApp recusou criar o grupo. Confere se todos os participantes têm número salvo.'
        : detail,
    )
  }
  upsertChat({
    id: result.gid,
    name,
    isGroup: true,
    lastAt: Date.now(),
  })
  return {
    ok: true,
    groupId: result.gid,
    title: result.title || name,
    added: result.added || participants.length,
  }
}

const CHAT_ACTIONS = new Set<CommandAction>([
  'mute',
  'unmute',
  'disappearing',
  'block',
  'unblock',
  'archive',
  'unarchive',
  'pin',
  'unpin',
  'call',
])

async function runChatAction(type: CommandAction, contactId: string, detail = '') {
  if (!client || state.status !== 'ready') throw new Error('WhatsApp não está conectado')
  if (!contactId) throw new Error('Escolha a conversa')
  if ((type === 'block' || type === 'unblock') && contactId.includes('@g.us')) {
    throw new Error('Bloqueio vale para contato, não para grupo')
  }

  if (type === 'mute') {
    const when =
      detail === '8h'
        ? new Date(Date.now() + 8 * 60 * 60 * 1000)
        : detail === '1w'
          ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
          : undefined
    await client.muteChat(contactId, when)
    upsertChat({ id: contactId, muted: true })
    return when ? 'Notificações silenciadas.' : 'Notificações silenciadas até você ligar de novo.'
  }
  if (type === 'unmute') {
    await client.unmuteChat(contactId)
    upsertChat({ id: contactId, muted: false })
    return 'Notificações ativadas.'
  }
  if (type === 'archive') {
    await client.archiveChat(contactId)
    upsertChat({ id: contactId, archived: true })
    return 'Conversa arquivada.'
  }
  if (type === 'unarchive') {
    await client.unarchiveChat(contactId)
    upsertChat({ id: contactId, archived: false })
    return 'Conversa desarquivada.'
  }
  if (type === 'pin') {
    const pinned = await client.pinChat(contactId)
    if (!pinned) throw new Error('Não deu para fixar. O topo já pode estar cheio.')
    upsertChat({ id: contactId, pinned: true })
    return 'Conversa adicionada aos favoritos e fixada no topo.'
  }
  if (type === 'unpin') {
    await client.unpinChat(contactId)
    upsertChat({ id: contactId, pinned: false })
    return 'Conversa desafixada.'
  }
  if (type === 'call') {
    const kind = detail === 'voice' ? 'voice' : 'video'
    const link = await client.createCallLink(new Date(Date.now() + 60_000), kind)
    if (!link) throw new Error('Não deu para gerar o link da chamada')
    return `Link da chamada: ${link}`
  }

  const seconds = Number(detail || 0)
  const script = readBrowserScript('chat-action.browser.js')
    .replace('"__CHAT_ID__"', JSON.stringify(contactId))
    .replace('"__ACTION__"', JSON.stringify(type))
    .replace('__SECONDS__', String(Number.isFinite(seconds) ? seconds : 0))
  await client.pupPage?.evaluate(script)
  if (type === 'block') return 'Contato bloqueado.'
  if (type === 'unblock') return 'Contato desbloqueado.'
  if (seconds === 86400) return 'Mensagens temporárias: 24 horas.'
  if (seconds === 604800) return 'Mensagens temporárias: 7 dias.'
  if (seconds === 7776000) return 'Mensagens temporárias: 90 dias.'
  return 'Mensagens temporárias desligadas.'
}

function messageIdsFor(contactId: string, messageIds?: string[], fromMe = false) {
  const picked = (messageIds ?? []).filter(Boolean)
  if (picked.length) return picked
  const list = listMessages(contactId).filter((item) => (fromMe ? item.fromMe : true))
  const last = list.at(-1)
  return last ? [last.id] : []
}

/** Turns any short ids (just the key) into full ids that WhatsApp Web / whatsapp-web.js can look up. */
async function resolveIds(contactId: string, ids: string[]) {
  if (ids.every(isFullMessageId)) return ids
  const full = (await runPageJob({ type: 'resolve', contactId, messageIds: ids })) as string[]
  return ids.map((id, index) => (Array.isArray(full) && full[index]) || id)
}

async function runPageJob(job: Record<string, unknown>) {
  if (!client?.pupPage) throw new Error('WhatsApp não está conectado')
  const script = `(async function () {
    ${PATCH_MSG_KEY}
    var job = ${JSON.stringify(job)}
    var C = window.require('WAWebCollections')
    function keyOf(id) {
      var match = /^(?:true|false)_[^_]+_([^_]+)/.exec(String(id))
      return match ? match[1] : String(id)
    }
    function idString(msg) {
      try { return String(msg.id._serialized || msg.id.$1 || msg.id.toString()) } catch (ignored) { return '' }
    }
    function byKey(list, key) {
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && list[i].id && list[i].id.id === key) return list[i]
      }
      return null
    }
    async function msgOf(id) {
      var msg = C.Msg.get(id)
      if (!msg) {
        try {
          var found = await C.Msg.getMessagesById([id])
          msg = found && found.messages && found.messages[0]
        } catch (ignored) {}
      }
      // Short ids (just the key) can't be looked up directly: find the message by its key.
      if (!msg) msg = byKey(C.Msg.getModelsArray(), keyOf(id))
      if (!msg && job.contactId) {
        var chat = C.Chat.get(job.contactId)
        if (chat && chat.msgs) msg = byKey(chat.msgs.getModelsArray(), keyOf(id))
      }
      if (!msg) throw new Error('Mensagem não encontrada')
      return msg
    }
    ${pollReader()}
    if (job.type === 'poll') {
      return await pollOf(await msgOf(job.messageIds[0]))
    }
    if (job.type === 'vote') {
      var pollMsg = await msgOf(job.messageIds[0])
      if (pollMsg.type !== 'poll_creation') throw new Error('Essa mensagem não é uma enquete')
      var picked = new Set(job.optionIds.map(Number))
      // An empty set removes your vote, like tapping your choice again in WhatsApp.
      await window.require('WAWebPollsSendVoteMsgAction').sendVote(pollMsg, picked)
      for (var tries = 0; tries < 10; tries++) {
        var after = await pollOf(pollMsg)
        var mineNow = after.options.filter(function (o) { return o.mine }).map(function (o) { return o.id }).sort().join(',')
        if (mineNow === Array.from(picked).sort().join(',')) return after
        await new Promise(function (done) { setTimeout(done, 150) })
      }
      return await pollOf(pollMsg)
    }
    if (job.type === 'resolve') {
      var full = []
      for (var r = 0; r < job.messageIds.length; r++) {
        try { full.push(idString(await msgOf(job.messageIds[r]))) } catch (ignored) { full.push('') }
      }
      return full
    }
    async function chatOf(msg) {
      return window.require('WAWebCollections').Chat.get(msg.id.remote) || await window.require('WAWebCollections').Chat.find(msg.id.remote)
    }
    var Cmd = window.require('WAWebCmd').Cmd
    if (job.type === 'forward') {
      for (var i = 0; i < job.messageIds.length; i++) await window.WWebJS.forwardMessage(job.targetId, job.messageIds[i])
      return job.messageIds.length
    }
    if (job.type === 'star' || job.type === 'unstar') {
      for (var s = 0; s < job.messageIds.length; s++) {
        var starred = await msgOf(job.messageIds[s])
        var starChat = await chatOf(starred)
        if (job.type === 'star') await Cmd.sendStarMsgs(starChat, [starred], false)
        else await Cmd.sendUnstarMsgs(starChat, [starred], false)
      }
      return job.messageIds.length
    }
    if (job.type === 'edit') {
      var editable = await msgOf(job.messageIds[0])
      if (!editable.id.fromMe) throw new Error('Só dá para editar uma mensagem sua')
      // editMessage's return value is always empty on current WhatsApp Web (it looks up id._serialized,
      // which no longer exists), so success = no exception from the edit itself.
      try {
        await window.WWebJS.editMessage(editable, job.text, { linkPreview: true, mentionedJidList: [], groupMentions: [] })
      } catch (error) {
        throw new Error('Só dá para editar uma mensagem sua recente (até 15 minutos)')
      }
      return 1
    }
    if (job.type === 'delete') {
      for (var d = 0; d < job.messageIds.length; d++) {
        var target = await msgOf(job.messageIds[d])
        var targetChat = await chatOf(target)
        if (job.everyone) await Cmd.sendRevokeMsgs(targetChat, { list: [target], type: 'message' }, { clearMedia: true })
        else await Cmd.sendDeleteMsgs(targetChat, { list: [target], type: 'message' }, true)
      }
      return job.messageIds.length
    }
    if (job.type === 'pinmsg' || job.type === 'unpinmsg') {
      var pinMsg = await msgOf(job.messageIds[0])
      var pinType = window.require('WAWebProtobufsE2E.pb').Message$PinInChatMessage$Type
      var pinned = await window.require('WAWebSendPinMessageAction').sendPinInChatMsg({
        msg: pinMsg,
        pinType: job.type === 'pinmsg' ? pinType.PIN_FOR_ALL : pinType.UNPIN_FOR_ALL,
        pinExpiryDurationOption: window.require('WAWebPinMsgConstants').DEFAULT_PIN_EXPIRY_DURATION_OPTION
      })
      if (!pinned || (pinned.messageSendResult && pinned.messageSendResult !== 'OK')) throw new Error(job.type === 'pinmsg' ? 'Não deu para fixar essa mensagem.' : 'Não deu para desafixar essa mensagem.')
      return 1
    }
    if (job.type === 'unread') {
      var unreadChat = window.require('WAWebCollections').Chat.get(job.contactId) || await window.require('WAWebCollections').Chat.find(job.contactId)
      await Cmd.markChatUnread(unreadChat, true)
      return 1
    }
    if (job.type === 'clear') {
      var cleared = await window.WWebJS.sendClearChat(job.contactId)
      if (!cleared) throw new Error('Não deu para limpar a conversa')
      return 1
    }
    throw new Error('Ação desconhecida')
  })()`
  return client.pupPage.evaluate(script)
}

async function assignList(contactId: string, name: string) {
  if (!client?.pupPage) throw new Error('WhatsApp não está conectado')
  if (!name.trim()) throw new Error('Diga o nome da lista, tipo: lista Trabalho')
  const script = `(async function(){
    var chatId = ${JSON.stringify(contactId)}
    var name = ${JSON.stringify(name.trim())}
    var collection = window.require('WAWebCollections')
    var labels = []
    try { labels = window.WWebJS.getLabels() || [] } catch (ignored) {}
    var found = null
    for (var i = 0; i < labels.length; i++) {
      if (String(labels[i].name || '').toLowerCase() === name.toLowerCase()) found = labels[i]
    }
    try {
      if (!found && collection.Label && typeof collection.Label.add === 'function') {
        found = await collection.Label.add({ name: name, color: 1 })
      }
      if (!found || found.id == null) throw new Error('sem lista')
      var chat = collection.Chat.get(chatId) || await collection.Chat.find(chatId)
      await collection.Label.addOrRemoveLabels([{ id: found.id, type: 'add' }], [chat])
      return String(found.name || name)
    } catch (error) {
      throw new Error('Esta conta não tem listas nomeadas. No WhatsApp pessoal isso fica no celular; por aqui os favoritos são o fixar.')
    }
  })()`
  return String(await client.pupPage.evaluate(script))
}

function chatOfMessage(messageId: string) {
  for (const [contactId, list] of messages) {
    if (list.some((item) => sameMessageId(item.id, messageId))) return contactId
  }
  // Full ids carry the chat: true_<chat>_<key>[_<sender>]
  return /^(?:true|false)_([^_]+)_/.exec(messageId)?.[1] ?? ''
}

/** Votes on a poll (optionIds = WhatsApp option localIds; [] removes your vote). Returns the updated poll. */
export async function votePoll(contactId: string, messageId: string, optionIds: number[]) {
  requireReady()
  const [fullId] = await resolveIds(contactId, [messageId])
  if (!fullId || !isFullMessageId(fullId)) throw new Error('Não achei a enquete')
  const poll = (await runPageJob({ type: 'vote', contactId, messageIds: [fullId], optionIds })) as ChatMessage['poll']
  if (poll) patchMessage(contactId, fullId, { poll })
  return poll
}

/** Re-reads a poll's votes from WhatsApp and pushes them to the app. */
async function refreshPoll(messageId: string) {
  const contactId = chatOfMessage(messageId)
  if (!contactId) return
  try {
    const poll = (await runPageJob({ type: 'poll', contactId, messageIds: [messageId] })) as ChatMessage['poll']
    if (poll) patchMessage(contactId, messageId, { poll })
  } catch (error) {
    console.warn('[zap] votos da enquete', error instanceof Error ? error.message.split('\n')[0] : error)
  }
}

export async function runWhatsAppCommand(input: {
  type: CommandAction
  contactIds: string[]
  text?: string
  file?: CommandFile
  messageIds?: string[]
}) {
  const contactId = input.contactIds[0] || ''
  if (input.type === 'reply') {
    const picked = messageIdsFor(contactId, input.messageIds)[0]
    if (!picked) throw new Error('Não achei a mensagem para responder')
    if (!input.text?.trim()) throw new Error('Digite a resposta')
    const [quoted] = await resolveIds(contactId, [picked])
    if (!quoted || !isFullMessageId(quoted)) throw new Error('Não achei a mensagem para responder')
    const preview = listMessages(contactId).find((item) => sameMessageId(item.id, quoted))
    await sendText(contactId, input.text.trim(), false, {
      id: quoted,
      text: (preview?.text || preview?.kind || 'mensagem').slice(0, 80),
    })
    return { sent: 1, failed: 0, message: 'Resposta enviada.' }
  }
  if (input.type === 'react') {
    const picked = messageIdsFor(contactId, input.messageIds)[0]
    if (!picked) throw new Error('Não achei a mensagem para reagir')
    const [target] = await resolveIds(contactId, [picked])
    // whatsapp-web.js silently does nothing for an id it can't find, so check first.
    if (!target || !isFullMessageId(target)) throw new Error('Não achei a mensagem para reagir')
    const emoji = input.text?.trim() || '👍'
    await requireReady().sendReaction(target, emoji)
    const current = listMessages(contactId).find((item) => sameMessageId(item.id, target))
    const others = (current?.reactions ?? []).filter((item) => !item.fromMe)
    patchMessage(contactId, target, { reactions: [...others, { emoji, fromMe: true, author: state.me?.id || '' }] })
    return { sent: 1, failed: 0, message: `Reação ${emoji} enviada.` }
  }
  if (input.type === 'delete') {
    const everyone = input.text !== 'me'
    const targets = messageIdsFor(contactId, input.messageIds, everyone)
    if (!targets.length) throw new Error(everyone ? 'Não achei uma mensagem sua para apagar' : 'Não achei a mensagem para apagar')
    const count = Number(await runPageJob({ type: 'delete', contactId, messageIds: targets, everyone })) || 0
    const resolved = await resolveIds(contactId, targets).catch(() => targets)
    const removedIds = [...new Set([...targets, ...resolved])]
    messages.set(
      contactId,
      (messages.get(contactId) ?? []).filter((item) => !removedIds.some((id) => sameMessageId(item.id, id))),
    )
    schedulePersist()
    waEvents.emit('thread', { contactId, messages: listMessages(contactId) })
    return {
      sent: count,
      failed: 0,
      message: count
        ? everyone
          ? `${count} mensagem(ns) apagada(s) para todos.`
          : `${count} mensagem(ns) apagada(s) para você.`
        : 'Não deu para apagar.',
      removedIds,
    }
  }
  if (input.type === 'forward') {
    const picked = (input.messageIds ?? []).filter(Boolean)
    if (!picked.length) throw new Error('Selecione a mensagem para encaminhar')
    if (!contactId) throw new Error('Diga para quem encaminhar')
    // The selected messages live in another chat, so resolve them without a chat hint.
    const ids = await resolveIds('', picked)
    const count = Number(await runPageJob({ type: 'forward', targetId: contactId, messageIds: ids })) || 0
    return { sent: count, failed: 0, message: 'Mensagem encaminhada.' }
  }
  if (input.type === 'star' || input.type === 'unstar') {
    const ids = messageIdsFor(contactId, input.messageIds)
    if (!ids.length) throw new Error('Não achei a mensagem')
    await runPageJob({ type: input.type, contactId, messageIds: ids })
    for (const id of ids) patchMessage(contactId, id, { starred: input.type === 'star' })
    return { sent: ids.length, failed: 0, message: input.type === 'star' ? 'Mensagem destacada.' : 'Destaque removido.' }
  }
  if (input.type === 'edit') {
    const id = messageIdsFor(contactId, input.messageIds, true)[0]
    if (!id) throw new Error('Não achei uma mensagem sua para editar')
    if (!input.text?.trim()) throw new Error('Digite o novo texto')
    await runPageJob({ type: 'edit', contactId, messageIds: [id], text: input.text.trim() })
    patchMessage(contactId, id, { text: input.text.trim() })
    return { sent: 1, failed: 0, message: 'Mensagem editada.' }
  }
  if (input.type === 'pinmsg' || input.type === 'unpinmsg') {
    const id = messageIdsFor(contactId, input.messageIds)[0]
    if (!id) throw new Error('Não achei a mensagem para fixar')
    await runPageJob({ type: input.type, contactId, messageIds: [id] })
    return { sent: 1, failed: 0, message: input.type === 'pinmsg' ? 'Mensagem fixada por 7 dias.' : 'Mensagem desafixada.' }
  }
  if (input.type === 'unread') {
    if (!contactId) throw new Error('Abra a conversa')
    await runPageJob({ type: 'unread', contactId })
    return { sent: 1, failed: 0, message: 'Conversa marcada como não lida.' }
  }
  if (input.type === 'clear') {
    if (!contactId) throw new Error('Abra a conversa')
    await runPageJob({ type: 'clear', contactId })
    messages.set(contactId, [])
    waEvents.emit('thread', { contactId, messages: [] })
    return { sent: 1, failed: 0, message: 'Conversa limpa.', cleared: true }
  }
  if (input.type === 'contact') {
    if (!client) throw new Error('WhatsApp não está conectado')
    const [name, phone] = (input.text || '').split('|')
    const digits = (phone || '').replace(/\D/g, '')
    if (!name || !digits) throw new Error('Diga o contato, tipo: manda o contato do Pedro')
    const card = `BEGIN:VCARD\nVERSION:3.0\nFN:${name}\nTEL;type=CELL;waid=${digits}:+${digits}\nEND:VCARD`
    await client.sendMessage(contactId, card, { parseVCards: true })
    return { sent: 1, failed: 0, message: `Contato ${name} enviado.` }
  }
  if (input.type === 'poll') {
    const parts = (input.text || '').split('|').map((part) => part.trim()).filter(Boolean)
    if (!client) throw new Error('WhatsApp não está conectado')
    if (parts.length < 3) throw new Error('Use: enquete Pergunta | opção 1 | opção 2')
    await client.sendMessage(contactId, new Poll(parts[0] || 'Enquete', parts.slice(1)))
    return { sent: 1, failed: 0, message: 'Enquete enviada.' }
  }
  if (input.type === 'label') {
    const listName = await assignList(contactId, input.text || '')
    return { sent: 1, failed: 0, message: `Conversa na lista ${listName}.` }
  }
  if (CHAT_ACTIONS.has(input.type)) {
    const message = await runChatAction(input.type, input.contactIds[0] || '', input.text || '')
    return { sent: 1, failed: 0, message }
  }
  if (input.type === 'group') {
    const created = await createGroupCommand(input.contactIds, input.text || '')
    return {
      sent: created.added,
      failed: 0,
      groupId: created.groupId,
      title: created.title,
    }
  }
  if (input.type === 'photo' || input.type === 'audio' || input.type === 'video' || input.type === 'document' || input.type === 'sticker' || input.type === 'gif') {
    if (!input.file) throw new Error('Anexe o arquivo')
    if (input.contactIds.length === 1) {
      const kind =
        input.type === 'photo' ? 'photo' : input.type === 'audio' ? 'audio' : input.type === 'video' ? 'video' : input.type
      await sendChatFile(input.contactIds[0]!, input.file, kind, input.text || '')
      return { sent: 1, failed: 0, message: 'Arquivo enviado.' }
    }
    if (input.type !== 'photo' && input.type !== 'audio') throw new Error('Disparo em massa vale para texto, foto e áudio')
    return sendMediaBlast(input.contactIds, input.file, input.text || '', input.type)
  }
  return sendBlast(input.contactIds, input.text || '')
}

function requireReady() {
  if (!client || state.status !== 'ready') throw new Error('WhatsApp não está conectado')
  return client
}

export function watchChat(contactId: string) {
  if (watchId && watchId !== contactId) upsertChat({ id: watchId, typing: '' })
  watchId = contactId
  lastPresence = ''
  if (presenceTimer) return
  presenceTimer = setInterval(() => {
    void pollPresence()
  }, 2000)
}

async function pollPresence() {
  if (!watchId || !client?.pupPage || state.status !== 'ready') return
  const id = watchId
  const script = `(function(){
    var id = ${JSON.stringify(id)}
    try {
      var chat = window.require('WAWebCollections').Chat.get(id)
      if (!chat) return ''
      var presence = chat.presence
      var type = ''
      if (presence && presence.chatstates && presence.chatstates.getModelsArray) {
        var models = presence.chatstates.getModelsArray()
        for (var i = 0; i < models.length; i++) {
          var st = String(models[i].type || models[i].chatstate || '')
          if (st === 'composing' || st === 'recording') type = st
        }
      }
      if (!type && presence && presence.type) type = String(presence.type)
      if (!type && (chat.isOnline || (presence && presence.isOnline))) return 'available'
      return type
    } catch (error) {
      return ''
    }
  })()`
  try {
    const result = String((await client.pupPage.evaluate(script)) || '')
    if (result === lastPresence && id === watchId) return
    lastPresence = result
    const typing = result === 'composing' ? 'digitando...' : result === 'recording' ? 'gravando áudio...' : ''
    const online = result === 'available' || Boolean(typing)
    upsertChat({
      id,
      typing,
      online,
      lastSeen: online ? 'online' : chats.get(id)?.lastSeen,
    })
  } catch {
    /* ignore */
  }
}

export async function markRead(contactId: string) {
  const current = requireReady()
  upsertChat({ id: contactId, unread: 0 })
  try {
    const chat = await current.getChatById(contactId)
    await chat.sendSeen?.()
  } catch (error) {
    console.warn('[zap] marcar lida', error instanceof Error ? error.message : error)
  }
}

export async function sendTyping(contactId: string, on: boolean) {
  const current = requireReady()
  const chat = await current.getChatById(contactId)
  if (on) await chat.sendStateTyping?.()
  else await chat.clearState?.()
}

export async function openNumber(raw: string) {
  const current = requireReady()
  const digits = raw.replace(/\D/g, '')
  if (digits.length < 8) throw new Error('Digite o número com DDD')
  const wid = await current.getNumberId(digits)
  if (!wid?._serialized) throw new Error('Esse número não está no WhatsApp')
  upsertChat({
    id: wid._serialized,
    name: `+${digits}`,
    phone: `+${digits}`,
    isGroup: false,
    lastAt: Date.now(),
  })
  return chats.get(wid._serialized)!
}

async function downloadInPage(contactId: string, messageId: string) {
  if (!client?.pupPage) return ''
  const script = readBrowserScript('download-one.browser.js')
    .replace('"__CHAT_ID__"', JSON.stringify(contactId))
    .replace('"__MESSAGE_ID__"', JSON.stringify(messageId))
  const media = await client.pupPage.evaluate(script)
  return typeof media === 'string' ? media : ''
}

export async function fetchMessageMedia(contactId: string, messageId: string) {
  const current = requireReady()
  let media = ''
  const [fullId = messageId] = await resolveIds(contactId, [messageId]).catch(() => [messageId])
  try {
    const msg = await current.getMessageById(fullId)
    const file = await msg.downloadMedia?.()
    if (file?.data) media = `data:${file.mimetype || 'application/octet-stream'};base64,${file.data}`
  } catch {
    media = ''
  }
  if (!media.startsWith('data:')) media = await downloadInPage(contactId, fullId)
  if (!media.startsWith('data:')) throw new Error('Não deu para baixar essa mídia')
  patchMessage(contactId, messageId, { media })
  return media
}

export async function searchMessages(query: string) {
  requireReady()
  const needle = query.trim().toLowerCase()
  if (needle.length < 2 || !client?.pupPage) return []
  const script = `(function(){
    var q = ${JSON.stringify(needle)}
    function serialized(id) {
      if (!id) return ''
      if (typeof id === 'string') return id
      if (id._serialized) return String(id._serialized)
      return ''
    }
    var chats = []
    try { chats = window.require('WAWebCollections').Chat.getModelsArray() || [] } catch (ignored) {}
    var hits = []
    for (var i = 0; i < chats.length && hits.length < 40; i++) {
      var chat = chats[i]
      var id = serialized(chat.id)
      if (!id) continue
      var name = String(chat.formattedTitle || chat.name || '')
      var msgs = chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray().slice(-80) : []
      if (chat.lastMessage) msgs.push(chat.lastMessage)
      for (var j = msgs.length - 1; j >= 0 && hits.length < 40; j--) {
        var body = String(msgs[j].body || msgs[j].caption || '')
        if (body.toLowerCase().indexOf(q) === -1) continue
        hits.push({
          contactId: id,
          contactName: name,
          messageId: serialized(msgs[j].id),
          text: body.slice(0, 160),
          at: Number(msgs[j].t || 0) * 1000
        })
      }
    }
    return hits
  })()`
  const rows = (await client.pupPage.evaluate(script)) as {
    contactId?: string
    contactName?: string
    messageId?: string
    text?: string
    at?: number
  }[]
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => row.contactId && row.messageId)
    .map((row) => ({
      contactId: String(row.contactId),
      contactName: String(row.contactName || ''),
      messageId: String(row.messageId),
      text: String(row.text || ''),
      at: Number(row.at || 0),
    }))
}

export async function exportHistory(contactId: string) {
  requireReady()
  const seen = new Set<string>()
  const all: ChatMessage[] = []
  let before = 0
  for (let round = 0; round < 20; round++) {
    const batch = await scrapeThread(contactId, before)
    if (!batch.length) break
    let oldest = Number.MAX_SAFE_INTEGER
    let added = 0
    for (const msg of batch) {
      if (!msg.id || seen.has(msg.id)) continue
      seen.add(msg.id)
      added += 1
      const stored = fromWwebMessage(
        {
          id: { _serialized: msg.id, id: msg.id },
          from: msg.fromMe ? state.me?.id || contactId : contactId,
          to: contactId,
          body: msg.body,
          fromMe: msg.fromMe,
          timestamp: msg.timestamp,
          type: msg.kind === 'text' ? 'chat' : msg.kind,
        },
        contactId,
        {
          kind: msg.kind,
          media: msg.media,
          authorId: msg.authorId,
          authorName: msg.authorName,
          duration: msg.duration,
          quote: msg.quote,
          ack: msg.ack,
          starred: msg.starred,
          reactions: msg.reactions,
          poll: msg.poll,
          filename: msg.filename,
        },
      )
      if (stored) all.push(stored)
      if (msg.timestamp && msg.timestamp < oldest) oldest = msg.timestamp
    }
    if (!added || oldest === Number.MAX_SAFE_INTEGER) break
    before = oldest
  }
  return all.sort((a, b) => a.at - b.at)
}

export async function messageInfo(messageId: string) {
  requireReady()
  if (!client?.pupPage) return { delivered: [] as string[], read: [] as string[] }
  const [fullId = messageId] = await resolveIds('', [messageId]).catch(() => [messageId])
  const script = `(async function(){
    var id = ${JSON.stringify(fullId)}
    function names(list) {
      var arr = list && list.getModelsArray ? list.getModelsArray() : Array.isArray(list) ? list : []
      var out = []
      for (var i = 0; i < arr.length; i++) {
        var row = arr[i]
        out.push(String(row.pushname || row.name || (row.id && row.id.user) || 'Contato'))
      }
      return out
    }
    var msg = window.require('WAWebCollections').Msg.get(id)
    if (!msg) {
      var found = await window.require('WAWebCollections').Msg.getMessagesById([id])
      msg = found && found.messages && found.messages[0]
    }
    if (!msg) return { delivered: [], read: [] }
    var info = null
    try { if (typeof msg.getInfo === 'function') info = await msg.getInfo() } catch (ignored) {}
    if (!info) {
      try { info = await window.require('WAWebMsgInfo').queryMsgInfo(msg) } catch (ignored) {}
    }
    return {
      delivered: names(info && (info.delivery || info.delivered)),
      read: names(info && (info.read || info.played)),
    }
  })()`
  const result = (await client.pupPage.evaluate(script)) as { delivered?: string[]; read?: string[] }
  return {
    delivered: Array.isArray(result?.delivered) ? result.delivered : [],
    read: Array.isArray(result?.read) ? result.read : [],
  }
}

export async function reportChat(contactId: string) {
  requireReady()
  if (!client?.pupPage) throw new Error('WhatsApp não está conectado')
  const script = `(async function(){
    var id = ${JSON.stringify(contactId)}
    var chat = window.require('WAWebCollections').Chat.get(id) || await window.require('WAWebCollections').Chat.find(id)
    var Cmd = window.require('WAWebCmd').Cmd
    if (typeof Cmd.sendReportSpam === 'function') {
      await Cmd.sendReportSpam(chat)
      return true
    }
    if (chat && typeof chat.report === 'function') {
      await chat.report()
      return true
    }
    throw new Error('Esta versão do WhatsApp não deixa denunciar por aqui')
  })()`
  await client.pupPage.evaluate(script)
  return 'Denúncia enviada ao WhatsApp.'
}

export async function listStatuses() {
  requireReady()
  if (!client?.pupPage) return []
  const script = `(function(){
    function serialized(id) {
      if (!id) return ''
      if (typeof id === 'string') return id
      if (id._serialized) return String(id._serialized)
      return ''
    }
    var out = []
    try {
      var col = window.require('WAWebCollections').Status
      var models = col && col.getModelsArray ? col.getModelsArray() : []
      for (var i = 0; i < models.length && out.length < 30; i++) {
        var st = models[i]
        var id = serialized(st.id)
        var contact = null
        try { contact = window.require('WAWebCollections').Contact.get(st.id) } catch (ignored) {}
        var msgs = st.msgs && st.msgs.getModelsArray ? st.msgs.getModelsArray() : []
        var last = msgs.length ? msgs[msgs.length - 1] : st
        // For photo/video statuses, body holds a base64 thumbnail, not text: use the caption or a label.
        var kind = String(last.type || '')
        var text = kind === 'chat' || kind === 'text' ? String(last.body || '') : String(last.caption || '')
        if (!text && kind === 'image') text = 'Foto'
        if (!text && kind === 'video') text = 'Vídeo'
        if (!text && (kind === 'ptt' || kind === 'audio')) text = 'Áudio'
        if (/^(\\/9j\\/|iVBOR|UklGR|R0lGOD)/.test(text) && text.length > 64) text = 'Foto'
        out.push({
          id: id,
          name: String((contact && (contact.name || contact.pushname)) || st.name || 'Status'),
          unread: Number(st.unreadCount || 0),
          text: text,
          at: Number(last.t || st.t || 0) * 1000
        })
      }
    } catch (ignored) {}
    return out
  })()`
  const rows = (await client.pupPage.evaluate(script)) as {
    id?: string
    name?: string
    unread?: number
    text?: string
    at?: number
  }[]
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    id: String(row.id || ''),
    name: String(row.name || 'Status'),
    unread: Number(row.unread || 0),
    text: String(row.text || ''),
    at: Number(row.at || 0),
  }))
}

export async function postStatus(text: string, file?: CommandFile) {
  const current = requireReady()
  if (file?.data) {
    const media = new MessageMedia(file.mimetype || 'image/jpeg', asBase64(file.data), file.name || 'status')
    await current.sendMessage('status@broadcast', media, { caption: text.trim() || undefined })
    return 'Status publicado.'
  }
  if (!text.trim()) throw new Error('Escreva o status ou anexe uma foto')
  await current.sendMessage('status@broadcast', text.trim())
  return 'Status publicado.'
}

export async function startCall(contactId: string, video: boolean) {
  const current = requireReady()
  let live = false
  if (client?.pupPage) {
    const script = `(async function(){
      var id = ${JSON.stringify(contactId)}
      var video = ${video ? 'true' : 'false'}
      var chat = window.require('WAWebCollections').Chat.get(id) || await window.require('WAWebCollections').Chat.find(id)
      var names = ['WAWebVoipStartCall', 'WAWebStartCall']
      for (var i = 0; i < names.length; i++) {
        try {
          var mod = window.require(names[i])
          var fn = mod && (mod.startCall || (mod.default && mod.default.startCall))
          if (typeof fn === 'function') {
            await fn(chat, { isVideo: video, withVideo: video })
            return true
          }
        } catch (ignored) {}
      }
      return false
    })()`
    try {
      live = Boolean(await client.pupPage.evaluate(script))
    } catch {
      live = false
    }
  }
  if (live) {
    return { mode: 'live' as const, message: video ? 'Chamada de vídeo iniciada no WhatsApp.' : 'Chamada de voz iniciada no WhatsApp.' }
  }
  const link = await current.createCallLink(new Date(Date.now() + 60_000), video ? 'video' : 'voice')
  if (!link) throw new Error('Não deu para iniciar a chamada')
  return { mode: 'link' as const, link: String(link), message: 'A chamada ao vivo não abriu. O link está pronto para enviar.' }
}

export async function groupAction(input: {
  contactId: string
  action: 'add' | 'remove' | 'promote' | 'demote' | 'leave' | 'subject' | 'description' | 'picture' | 'invite'
  participantId?: string
  text?: string
  file?: CommandFile
}) {
  const current = requireReady()
  if (!input.contactId.endsWith('@g.us')) throw new Error('Isso só funciona em grupo')
  const chat = await current.getChatById(input.contactId)
  // whatsapp-web.js reports a refusal (e.g. you're not an admin) by returning false instead of
  // throwing. Treat that as an error, and never relabel the chat unless WhatsApp accepted it.
  const refused = 'O WhatsApp não deixou. Neste grupo, só os admins podem mudar isso.'
  const groupFn = <A extends unknown[]>(fn: ((...args: A) => Promise<unknown>) | undefined) => {
    if (!fn) throw new Error('Essa conversa não é um grupo')
    return fn.bind(chat)
  }
  if (input.action === 'add') {
    if (!input.participantId) throw new Error('Escolha quem adicionar')
    const result = await groupFn(chat.addParticipants)([input.participantId])
    if (typeof result === 'string') throw new Error(result)
    const row = result && typeof result === 'object' ? (Object.values(result)[0] as { code?: number; message?: string; isInviteV4Sent?: boolean }) : undefined
    if (row?.code && row.code !== 200) {
      if (row.isInviteV4Sent) return 'A pessoa não deixa ser adicionada direto. Mandei um convite para ela.'
      throw new Error(row.message || 'O WhatsApp não deixou adicionar essa pessoa.')
    }
    return 'Pessoa adicionada ao grupo.'
  }
  if (input.action === 'remove') {
    if (!input.participantId) throw new Error('Escolha quem remover')
    await groupFn(chat.removeParticipants)([input.participantId])
    return 'Pessoa removida do grupo.'
  }
  if (input.action === 'promote') {
    if (!input.participantId) throw new Error('Escolha o participante')
    await groupFn(chat.promoteParticipants)([input.participantId])
    return 'Participante promovido a admin.'
  }
  if (input.action === 'demote') {
    if (!input.participantId) throw new Error('Escolha o participante')
    await groupFn(chat.demoteParticipants)([input.participantId])
    return 'Admin rebaixado.'
  }
  if (input.action === 'leave') {
    await groupFn(chat.leave)()
    return 'Você saiu do grupo.'
  }
  if (input.action === 'subject') {
    const name = input.text?.trim() || ''
    if (!name) throw new Error('Digite o nome do grupo')
    if ((await groupFn(chat.setSubject)(name)) === false) throw new Error(refused)
    upsertChat({ id: input.contactId, name })
    return 'Nome do grupo atualizado.'
  }
  if (input.action === 'description') {
    if ((await groupFn(chat.setDescription)(input.text?.trim() || '')) === false) throw new Error(refused)
    return 'Descrição do grupo atualizada.'
  }
  if (input.action === 'picture') {
    if (!input.file?.data) throw new Error('Escolha uma foto')
    const media = new MessageMedia(input.file.mimetype || 'image/jpeg', asBase64(input.file.data), input.file.name || 'grupo')
    if ((await groupFn(chat.setPicture)(media)) === false) throw new Error(refused)
    return 'Foto do grupo atualizada.'
  }
  const code = await chat.getInviteCode?.()
  if (!code) throw new Error('Não deu para gerar o link do grupo')
  return `https://chat.whatsapp.com/${code}`
}

export async function logout() {
  try {
    await client?.logout()
  } catch {
    /* ignore */
  }
  try {
    await client?.destroy()
  } catch {
    /* ignore */
  }
  client = null
  clearInterval(presenceTimer)
  presenceTimer = undefined
  watchId = ''
  chats.clear()
  messages.clear()
  photos.clear()
  photoQueued.clear()
  photoQueue.length = 0
  clearTimeout(persistTimer)
  try {
    clearCache()
  } catch (error) {
    console.warn('[zap] não deu para apagar o cache', error instanceof Error ? error.message : error)
  }
  await rm(AUTH_DIR, { recursive: true, force: true })
  setState({ status: 'idle', qr: null, me: null })
  startWhatsApp()
}
