import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ChatMessage, Contact } from './types.ts'

const FILE = path.join(process.cwd(), 'data', 'cache.json')

type CacheFile = {
  chats: Contact[]
  messages: Record<string, ChatMessage[]>
}

function slim(message: ChatMessage): ChatMessage {
  const next = { ...message }
  delete next.media
  return next
}

export function loadCache(): CacheFile | null {
  try {
    const raw = readFileSync(FILE, 'utf8')
    const parsed = JSON.parse(raw) as CacheFile
    if (!Array.isArray(parsed.chats) || !parsed.messages) return null
    return parsed
  } catch {
    return null
  }
}

/** Deletes the cached chats and messages (used on logout so the old account's data doesn't come back). */
export function clearCache() {
  rmSync(FILE, { force: true })
}

export function saveCache(chats: Contact[], messages: Map<string, ChatMessage[]>) {
  const packed: Record<string, ChatMessage[]> = {}
  for (const [id, list] of messages) {
    packed[id] = list.slice(-80).map(slim)
  }
  const body: CacheFile = {
    chats: chats.map((chat) => ({ ...chat, typing: '' })),
    messages: packed,
  }
  mkdirSync(path.dirname(FILE), { recursive: true })
  writeFileSync(FILE, JSON.stringify(body))
}
