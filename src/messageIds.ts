// Shared by the browser app and the server (server imports this file directly).
//
// A full WhatsApp message id looks like:
//   true_5511999990001@c.us_3EB0B86DB7B54D686A69                 (1:1 chat)
//   true_120363000000000017@g.us_3EB0B86DB7B54D686A69_25600097@lid  (group: sender at the end)
// Only the full form can be looked up in WhatsApp Web. The middle part (3EB0…) is the
// message key and is what identifies the message.
//
// Recent WhatsApp Web builds removed `id._serialized`; the full id now lives in `id.$1`
// (or `id.toString()` in the page), so never rely on `_serialized` alone.

const FULL_ID = /^(?:true|false)_[^_]+_([^_]+)/

/** The message key (the part that identifies the message), for full or short ids. */
export function messageKey(id: string) {
  return FULL_ID.exec(id)?.[1] ?? id
}

export function isFullMessageId(id: string) {
  return FULL_ID.test(id)
}

type RawJid = string | { _serialized?: string; $1?: string; user?: string; server?: string } | null | undefined

export type RawMessageId =
  | string
  | {
      _serialized?: string
      $1?: string
      fromMe?: boolean
      remote?: RawJid
      id?: string
      participant?: RawJid
    }
  | null
  | undefined

function jidString(value: RawJid) {
  if (!value) return ''
  if (typeof value === 'string') return value
  return value._serialized || value.$1 || (value.user && value.server ? `${value.user}@${value.server}` : '')
}

/** Full id string from whatever shape whatsapp-web.js / WhatsApp Web hands us. */
export function serializeMessageId(raw: RawMessageId): string {
  if (!raw) return ''
  if (typeof raw === 'string') return raw
  if (raw._serialized) return raw._serialized
  if (raw.$1) return raw.$1
  const remote = jidString(raw.remote)
  if (raw.id && remote) {
    const participant = jidString(raw.participant)
    return `${raw.fromMe ? 'true' : 'false'}_${remote}_${raw.id}${participant ? `_${participant}` : ''}`
  }
  return raw.id || ''
}

/** True when two ids point to the same message (full vs short forms included). */
export function sameMessageId(a: string, b: string) {
  if (a === b) return true
  const left = messageKey(a)
  return left.length > 8 && left === messageKey(b)
}
