import type { Contact } from './types.ts'

const COLORS = [
  '#00a884',
  '#53bdeb',
  '#df9d3a',
  '#c486ea',
  '#06cf9c',
  '#ef5d6a',
  '#6aa3f9',
  '#f7a356',
  '#2dd4bf',
  '#8b9cff',
]

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function colorFor(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return COLORS[hash % COLORS.length]!
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
}

export function jidPhone(jid: string) {
  const user = jid.split('@')[0]?.split(':')[0] ?? ''
  if ((jid.endsWith('@s.whatsapp.net') || jid.endsWith('@c.us')) && /^\d+$/.test(user)) return `+${user}`
  return ''
}

export function isHumanName(name?: string | null): name is string {
  return Boolean(name && !name.includes('@'))
}

export function displayName(jid: string, fallback?: string | null) {
  if (isHumanName(fallback)) return fallback
  return jidPhone(jid) || 'Contato'
}

export function isUsefulJid(jid: string | null | undefined): jid is string {
  if (!jid) return false
  if (jid === 'status@broadcast') return false
  if (jid.endsWith('@broadcast')) return false
  if (jid.endsWith('@newsletter')) return false
  return (
    jid.endsWith('@s.whatsapp.net') ||
    jid.endsWith('@c.us') ||
    jid.endsWith('@g.us') ||
    jid.endsWith('@lid')
  )
}

export function renderTemplate(template: string, contact: Pick<Contact, 'name'>) {
  const firstName = contact.name.split(' ')[0] ?? contact.name
  return template
    .replaceAll('{nome_completo}', contact.name)
    .replaceAll('{nome}', firstName)
}
