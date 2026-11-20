import type { CommandAction } from './types'
import type { Contact } from './types'

export type LocalCommand = 'info' | 'search' | 'close' | 'export' | 'select' | 'theme' | 'lock' | 'report'

export type AssistKind =
  | 'summary'
  | 'unread'
  | 'today'
  | 'audio-today'
  | 'find'
  | 'open'
  | 'group-add'
  | 'group-link'
  | 'group-rename'
  | 'pending'
  | 'suggest'
  | 'focus-open'
  | 'focus-reply'
  | 'help'
  | 'statuses'
  | 'status-post'
  | 'mark-read'
  | 'group-remove'
  | 'group-promote'
  | 'group-demote'
  | 'group-leave'
  | 'group-description'
  | 'group-picture'
  | 'group-create'
  | 'lock-app'
  | 'logout'

export type ParsedCommand = {
  type: CommandAction
  local?: LocalCommand
  assist?: AssistKind
  detail?: string
  label: string
  contactIds: string[]
  phone?: string
  thenReply?: string
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// JavaScript's \b treats accented letters (é, ã, ç…) as non-letters, so "André" or "cadê"
// never match with \b. These helpers use Unicode-aware boundaries instead.
const LETTER = '[\\p{L}\\p{N}_]'
const START = `(?<!${LETTER})`
const END = `(?!${LETTER})`

/** Lowercase and strip accents, keeping the exact same string length so match indexes line up with the original. */
export function fold(value: string) {
  let out = ''
  for (const ch of value) {
    const lower = ch.toLowerCase()
    const base = lower.length === ch.length ? lower : ch
    const plain = base.normalize('NFD').replace(/\p{M}/gu, '')
    out += plain.length === ch.length ? plain : base
  }
  return out
}

/** Regex for whole words (already folded/escaped source), with Unicode-aware boundaries. */
function words(source: string, flags = '') {
  return new RegExp(`${START}(?:${source})${END}`, `${flags}u`)
}

function nameForms(contact: Contact) {
  const full = fold(contact.name.trim())
  const first = full.split(/\s+/)[0] ?? ''
  const forms: string[] = []
  if (full.length >= 3) forms.push(full)
  if (first.length >= 3 && first !== full) forms.push(first)
  return forms
}

function byNameLength(contacts: Contact[]) {
  return [...contacts].sort((a, b) => b.name.length - a.name.length)
}

/**
 * Groups named by their FULL name inside `part` (never by first word: group names like
 * "Vagas T.I." or "Grupo da Família" start with common words). Group actions must only look
 * at the part of the sentence that says WHICH group, never at the new name or description.
 */
export function groupsNamed(part: string, contacts: Contact[]) {
  const low = fold(part)
  return byNameLength(contacts.filter((contact) => contact.isGroup)).filter((group) => {
    const full = fold(group.name.trim())
    return full.length >= 2 && words(escapeRegExp(full)).test(low)
  })
}

/** Group target + person for add/remove/promote/demote ("remove o Bruno do grupo Família"). */
function memberCommand(original: string, contacts: Contact[], loose: Contact[]) {
  const group = groupsNamed(original, contacts)[0]
  const person = loose.find((contact) => !contact.isGroup)
  return {
    person,
    contactIds: [group?.id, person?.id].filter((id): id is string => Boolean(id)),
  }
}

export function mentionedContacts(input: string, contacts: Contact[]) {
  let rest = fold(input)
  const found: Contact[] = []
  for (const contact of byNameLength(contacts)) {
    for (const form of nameForms(contact)) {
      const pattern = words(escapeRegExp(form))
      if (!pattern.test(rest)) continue
      found.push(contact)
      rest = rest.replace(pattern, ' ')
      break
    }
  }
  return found
}

/** Edits a string through its folded copy, so regexes can be accent-insensitive while the cut text keeps its accents. */
function cutter(input: string) {
  let raw = input
  let low = fold(input)
  return {
    get raw() {
      return raw
    },
    get low() {
      return low
    },
    cut(pattern: RegExp, from = 0) {
      const match = pattern.exec(low.slice(from))
      if (!match) return null
      const start = from + match.index
      const end = start + match[0].length
      raw = `${raw.slice(0, start)} ${raw.slice(end)}`
      low = `${low.slice(0, start)} ${low.slice(end)}`
      return { start, match }
    },
  }
}

const FILLERS = [
  words('(?:(?:uma|um)\\s+)?mensagem'),
  words('dizendo|falando|avisando|perguntando'),
  words('com\\s+(?:a\\s+)?legenda|legenda'),
  words('que'),
]

function tidy(text: string) {
  return text.replace(/\s+/g, ' ').replace(/^[\s,;:-]+|[\s,;:-]+$/g, '').trim()
}

function stripFillers(text: string) {
  let rest = tidy(text)
  for (let round = 0; round < 4; round++) {
    const before = rest
    for (const filler of FILLERS) {
      const low = fold(rest)
      const match = filler.exec(low)
      if (match && match.index === 0) rest = tidy(rest.slice(match[0].length))
    }
    if (rest === before) break
  }
  return rest
}

/**
 * Splits "manda oi pra Ana" into the message ("oi") and the recipients ([Ana]).
 * Only names in a "pra/pro/para Nome" phrase, right after the verb, or before a colon count as
 * recipients; every other word stays in the message exactly as typed.
 */
function messageParts(input: string, verb: string, contacts: Contact[], extra: RegExp[] = []) {
  const colon = /:(?!\d)/.exec(input)
  if (colon && words(verb).test(fold(input.slice(0, colon.index)))) {
    const body = input.slice(colon.index + 1)
    return { text: stripFillers(body), recipients: mentionedContacts(input.slice(0, colon.index), contacts) }
  }
  const work = cutter(input)
  const verbHit = work.cut(words(verb))
  const recipients: Contact[] = []
  const ranked = byNameLength(contacts)
  if (verbHit) {
    for (const contact of ranked) {
      const hit = nameForms(contact).some((form) =>
        work.cut(new RegExp(`^\\s*(?:(?:pra|pro|para|p\\/|ao|a|o)\\s+)?${escapeRegExp(form)}${END}`, 'u'), verbHit.start),
      )
      if (hit) {
        recipients.push(contact)
        break
      }
    }
  }
  for (const contact of ranked) {
    if (recipients.includes(contact)) continue
    const hit = nameForms(contact).some((form) =>
      work.cut(words(`(?:pra|pro|para|p\\/)\\s+(?:(?:o|a|os|as)\\s+)?${escapeRegExp(form)}`)),
    )
    if (hit) recipients.push(contact)
  }
  for (const pattern of extra) work.cut(pattern)
  return { text: stripFillers(work.raw), recipients }
}

function mentionBoundary(after: string, length: number) {
  return after.length === length || !/[\p{L}\p{N}_]/u.test(after[length] || '')
}

export function messageMentions(input: string, contacts: Contact[]) {
  const found: Contact[] = []
  const unmatched: string[] = []
  let rest = input
  while (true) {
    const at = rest.indexOf('@')
    if (at < 0) break
    const after = rest.slice(at + 1)
    let best: { contact: Contact; length: number } | null = null
    for (const contact of contacts) {
      const name = fold(contact.name.trim())
      const first = name.split(/\s+/)[0] ?? ''
      const lower = fold(after)
      if (name.length >= 2 && lower.startsWith(name) && mentionBoundary(after, name.length)) {
        if (!best || name.length > best.length) best = { contact, length: name.length }
        continue
      }
      if (first.length >= 2 && lower.startsWith(first) && mentionBoundary(after, first.length)) {
        if (!best || first.length > best.length) best = { contact, length: first.length }
      }
    }
    if (!best) {
      const token = after.match(/^\S+/)?.[0]
      if (token) unmatched.push(token)
      rest = `${rest.slice(0, at)} ${after.slice(token?.length || 1)}`
      continue
    }
    if (!found.some((item) => item.id === best.contact.id)) found.push(best.contact)
    rest = `${rest.slice(0, at)} ${after.slice(best.length)}`
  }
  return {
    contacts: found,
    unmatched,
    text: rest.replace(/\s+/g, ' ').trim(),
  }
}

export function looseContacts(input: string, contacts: Contact[]) {
  const found = mentionedContacts(input, contacts)
  if (found.length) return found
  const extra: Contact[] = []
  let rest = fold(input)
  for (const contact of byNameLength(contacts)) {
    const first = fold(contact.name.trim()).split(/\s+/)[0] ?? ''
    if (first.length < 3) continue
    const short = words(escapeRegExp(first))
    if (!short.test(rest)) continue
    extra.push(contact)
    rest = rest.replace(short, ' ')
  }
  return extra
}

// Every form of the verb: manda, mande, mandar, envia, envie, enviar…
const SEND_VERB = '(?:mand|envi)\\p{L}*'
const PHONE = /(?:(?<![\p{L}\p{N}_])(?:pra|pro|para|p\/)\s+)?\+?\d[\d\s()-]{7,}\d/u

function phoneIn(input: string) {
  const match = input.match(/(?:\+?55\s*)?(?:\(?\d{2}\)?[\s-]*)?\d{4,5}[\s-]?\d{4}/)
  if (!match) return ''
  const digits = match[0].replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 13) return ''
  return digits.startsWith('55') ? digits : `55${digits}`
}

function askedName(input: string) {
  return input
    .replace(words('resumo|resumir|resume|resuma|faz um resumo|fa[cç]a um resumo|conversa|pendente|pend[eê]ncias|combinamos|sugere uma resposta|sugere resposta|sugerir resposta|sugira uma resposta|sugira resposta|o que ficou|o que', 'gi'), ' ')
    .replace(words('do|da|de|dos|das|o|a|os|as|que|pra|pro|para|com|no|na', 'gi'), ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function peopleAsked(input: string, contacts: Contact[]) {
  const hint = askedName(input)
  if (!hint) return []
  return looseContacts(hint, contacts)
}

function textAfter(input: string, verb: RegExp) {
  const colon = input.split(':').slice(1).join(':').trim()
  if (colon) return colon
  return input.replace(verb, ' ').replace(/^\s*(para|pra)\s+/i, '').replace(/\s+/g, ' ').trim()
}

/** Search keywords only: drops the verb, small words and the people named. Never use it for message text. */
function searchTerms(input: string, verb: string, people: Contact[]) {
  const work = cutter(input)
  const cutAll = (pattern: RegExp) => {
    while (work.cut(pattern)) {
      /* keep cutting */
    }
  }
  cutAll(words(verb))
  cutAll(words('pfv|por favor|pro|pra|para|com|por|uma|um|o|a|os|as|de|do|da|no|na|8 horas|8h|1 semana|7 dias|24 horas|90 dias'))
  for (const person of people) {
    for (const form of nameForms(person)) cutAll(words(escapeRegExp(form)))
  }
  return tidy(work.raw)
}

/**
 * People say the same command in several ways: "manda", "mande", "mandar"; "tira", "tire".
 * The checks below were written for the informal "você" form (manda, responde, tira…), so turn
 * the other common forms into that one first. Works on the folded (accent-free) text, which is
 * only used for matching — message text is always taken from the original sentence.
 */
const VERB_FORMS: [RegExp, string][] = [
  [/\bmande(m)?\b/g, 'manda'],
  [/\benvie(m)?\b/g, 'envia'],
  [/\brespond(a|am)\b/g, 'responde'],
  [/\bapague(m)?\b/g, 'apaga'],
  [/\bedite\b/g, 'edita'],
  [/\breaja\b/g, 'reage'],
  [/\bdessilencie\b/g, 'dessilencia'],
  [/\bsilencie\b/g, 'silencia'],
  [/\bdesafixe\b/g, 'desafixa'],
  [/\bfixe\b/g, 'fixa'],
  // Before the "add someone" rule, which would otherwise turn "coloque o nome" into "adiciona o nome".
  [/\b(coloque|coloca|ponha|poe|bote|bota) o nome\b/g, 'muda o nome'],
  [/\b(adicione|adicionar|acrescente|coloque|bote)\b(?= (o|a|os|as)\b)/g, 'adiciona'],
  [/\bremova\b/g, 'remove'],
  [/\bpromova\b/g, 'promove'],
  [/\brebaixe\b/g, 'rebaixa'],
  [/\babra\b/g, 'abre'],
  [/\bprocure\b/g, 'procura'],
  [/\bbusque\b/g, 'busca'],
  [/\bencontre\b/g, 'procura'],
  [/\btrave\b/g, 'trava'],
  [/\b(poste|publique)\b/g, 'posta'],
  [/\bsaia do grupo\b/g, 'sai do grupo'],
  [/\bmarque\b/g, 'marca'],
  [/\bgere\b/g, 'gera'],
  [/\b(mude|mudar|troque|trocar|troca|altere|alterar|altera)\b/g, 'muda'],
  [/\b(renomeie|renomear)\b/g, 'renomeia'],
  [/\bcrie\b/g, 'cria'],
  [/\bmostre\b/g, 'mostra'],
  [/\bresuma\b/g, 'resume'],
  [/\bsugira\b/g, 'sugere'],
  [/\b(limpe|limpa) a conversa\b/g, 'limpar conversa'],
  [/\btire\b/g, 'tira'],
  [/\bfale com\b/g, 'fala com'],
  [/\bconverse com\b/g, 'conversa com'],
  [/\bencaminhe\b/g, 'encaminha'],
  [/\bexporte\b/g, 'exporta'],
]

export function canonicalVerbs(folded: string) {
  return VERB_FORMS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), folded)
}

export function parseCommand(input: string, contacts: Contact[] = []): ParsedCommand | null {
  const original = input.trim().replace(/^(pfv|por favor)\s+/i, '')
  // Matching runs on an accent-free copy, so \b works and "cadê", "áudio", "Érica" match like
  // plain ASCII, with verb forms unified ("mude" → "muda", "tire" → "tira").
  const text = canonicalVerbs(fold(original))
  if (!text || text.length > 500) return null

  const people = mentionedContacts(original, contacts)
  const contactIds = people.map((contact) => contact.id)
  const base = { contactIds }
  const loose = looseContacts(original, contacts)

  // Group rename / description come first: their new name or description is free text that may
  // contain words other commands react to ("ajuda", "busca", "promove", a group's name…).
  if (/\b(muda o nome|renomeia|troca o nome)\b/i.test(text)) {
    // Split at the FIRST "para/pra": before it says which group, after it is the new name
    // ("muda o nome do grupo Família para Viagem para Bahia" → Família → "Viagem para Bahia").
    const cut = /\b(para|pra)\b/i.exec(original)
    const target = cut ? original.slice(0, cut.index) : original
    let detail = cut ? original.slice(cut.index + cut[0].length).trim() : ''
    // "coloque o nome Viagem" (no "para"): the new name comes right after "nome".
    if (!cut && /\b(coloque|coloca|ponha|poe|bote|bota) o nome\b/.test(fold(original))) {
      detail = /\bnome\s+(?:de\s+)?(.+)$/iu.exec(original)?.[1]?.trim() ?? ''
    }
    return {
      type: 'text',
      assist: 'group-rename',
      detail,
      contactIds: groupsNamed(target, contacts).map((group) => group.id),
      label: detail ? `Nome: ${detail}` : 'Mudar o nome',
    }
  }
  // "cria um grupo Viagem com a Ana e o Pedro": name between "grupo" and "com", members after "com".
  if (/\b(cria|criar|faz|faca|monta) (um )?(novo )?grupo\b|^novo grupo\b/.test(text)) {
    const match = /grupo\s+(.*?)(?:\s+com\s+(.+))?$/iu.exec(original)
    const name = (match?.[1] ?? '')
      .replace(/^(chamado|com o nome( de)?|de nome)\s+/i, '')
      .replace(/^["“”']|["“”']$/g, '')
      .trim()
    const members = mentionedContacts(match?.[2] ?? '', contacts).filter((contact) => !contact.isGroup)
    return {
      type: 'group',
      assist: 'group-create',
      detail: name,
      contactIds: members.map((contact) => contact.id),
      label: name ? `Criar grupo: ${name}` : 'Criar grupo',
    }
  }
  if (/\b(descricao do grupo|muda a descricao)\b/.test(text)) {
    // Unicode-aware: with plain \b, "descri\w*" stopped before "ção" and kept "ção" as the description.
    const verb = /(?<![\p{L}\p{N}_])(descri[cç][aã]o do grupo|(?:mud|troc|alter)\p{L}* a descri[cç][aã]o(?: do grupo)?)(?![\p{L}\p{N}_])/iu
    const detail = textAfter(original, verb)
    // The group can only be named before the description text (before ":" or before the verb).
    const colon = original.indexOf(':')
    const target = colon >= 0 ? original.slice(0, colon) : original.slice(0, verb.exec(original)?.index ?? 0)
    return {
      type: 'text',
      assist: 'group-description',
      detail,
      contactIds: groupsNamed(target, contacts).map((group) => group.id),
      label: detail ? `Descrição: ${detail}` : 'Descrição do grupo',
    }
  }

  if (/\b(abre|abrir)\b/i.test(text) && /\be\s+responde\b/i.test(text)) {
    const [left, right = ''] = original.split(/\be\s+respond\p{L}*/iu)
    const who = looseContacts(left, contacts)
    const detail = right.replace(/^\s*que\s+/i, '').trim()
    const leftover = left.replace(/\b(abre|abra|abrir|essa|conversa|da|do|de|pro|pra|para|a|o|as|os)\b/gi, '').trim()
    return {
      type: 'text',
      assist: 'open',
      contactIds: who.map((contact) => contact.id),
      detail: who.length ? '' : leftover,
      thenReply: detail,
      label: detail ? `Abrir e responder: ${detail}` : 'Abrir e responder',
    }
  }
  if (/\b(abre|abrir) essa\b/i.test(text)) {
    return { type: 'text', assist: 'focus-open', contactIds: [], label: 'Abrir essa' }
  }
  if (/\bresponde nessa\b/i.test(text)) {
    const detail = original.replace(/^.*\brespond\p{L}* nessa(?![\p{L}\p{N}_])\s*/iu, '').replace(/^que\s+/i, '').trim()
    return { type: 'reply', assist: 'focus-reply', detail, contactIds: [], label: detail ? `Responder: ${detail}` : 'Responder nessa' }
  }
  if (/\b(o que voc[eê] faz|o que voc[eê] sabe|quais comandos|lista de comandos|\bajuda\b)\b/i.test(text)) {
    return { type: 'text', assist: 'help', contactIds: [], label: 'O que eu faço' }
  }
  if (/\b(quem postou status|mostra os status|ver status|status de quem)\b/i.test(text)) {
    return { type: 'text', assist: 'statuses', contactIds: [], label: 'Status' }
  }
  if (/\b(posta um status|posta status|publica status|publicar status|meu status)\b/i.test(text)) {
    const detail = textAfter(original, /\b((?:posta|poste|publica|publique|publicar) (?:um )?status|meu status)\b/i)
    return { type: 'text', assist: 'status-post', detail, contactIds: [], label: detail ? `Status: ${detail}` : 'Publicar status' }
  }
  if (/\b(sai do grupo|sair do grupo)\b/i.test(text)) {
    return { type: 'text', assist: 'group-leave', contactIds: groupsNamed(original, contacts).map((group) => group.id), label: 'Sair do grupo' }
  }
  if (/\b(promove\w*|tornar admin|vira admin|torna admin)\b/i.test(text)) {
    const { person, contactIds } = memberCommand(original, contacts, loose)
    return {
      type: 'text',
      assist: 'group-promote',
      contactIds,
      detail: person?.id || '',
      label: person ? `Promover ${person.name}` : 'Promover a admin',
    }
  }
  if (/\b(rebaixa\w*|tira de admin|remover admin|remove admin)\b/i.test(text)) {
    const { person, contactIds } = memberCommand(original, contacts, loose)
    return {
      type: 'text',
      assist: 'group-demote',
      contactIds,
      detail: person?.id || '',
      label: person ? `Rebaixar ${person.name}` : 'Rebaixar admin',
    }
  }
  if (/\b(remove|tira)\b/i.test(text) && /\bgrupo\b/i.test(text) && !/favorit|estrela/.test(text)) {
    const { person, contactIds } = memberCommand(original, contacts, loose)
    return {
      type: 'text',
      assist: 'group-remove',
      contactIds,
      detail: person?.id || '',
      label: person ? `Remover ${person.name}` : 'Remover do grupo',
    }
  }
  if (/\b(foto do grupo|muda a foto|troca a foto)\b/i.test(text)) {
    return { type: 'text', assist: 'group-picture', contactIds: groupsNamed(original, contacts).map((group) => group.id), label: 'Foto do grupo' }
  }
  if (/\b(marca\b.*\bcomo lida|marcar como lida|marca lida|j[aá] li)\b/i.test(text)) {
    return { ...base, type: 'text', assist: 'mark-read', contactIds: loose.map((contact) => contact.id), label: 'Marcar como lida' }
  }
  if (/\b(fala com|abre o n[uú]mero|conversa com)\b/i.test(text)) {
    const phone = phoneIn(original)
    if (phone) {
      const detail = messageParts(original, 'fala com|abre o numero|conversa com', [], [PHONE]).text
      return { type: 'text', phone, detail, contactIds: [], label: `Falar com +${phone}` }
    }
    const who = loose
    if (who.length) {
      return { type: 'text', assist: 'open', contactIds: who.map((contact) => contact.id), label: `Abrir ${who[0]!.name}` }
    }
  }
  if (/\b(trava o app|travar o app|trava o chat zap|cadeado do app)\b/i.test(text)) {
    const pin = original.match(/\b(\d{4})\b/)?.[1] || ''
    return { type: 'text', assist: 'lock-app', detail: pin, contactIds: [], label: 'Travar o app' }
  }
  if (/\b(sair do whatsapp|sair do zap|desconecta\w*|logout)\b/i.test(text)) {
    return { type: 'text', assist: 'logout', contactIds: [], label: 'Sair do WhatsApp' }
  }
  if (/\b(o que ficou pendente|pend[eê]ncias|o que combinamos)\b/i.test(text)) {
    const who = peopleAsked(original, contacts)
    const hint = who.length ? '' : askedName(original)
    return {
      type: 'text',
      assist: 'pending',
      contactIds: who.map((contact) => contact.id),
      detail: hint,
      label: who[0] ? `Pendências de ${who[0].name}` : 'Pendências',
    }
  }
  if (/\b(sugere uma resposta|sugere resposta|sugerir resposta)\b/i.test(text)) {
    const who = peopleAsked(original, contacts)
    const hint = who.length ? '' : askedName(original)
    return {
      type: 'text',
      assist: 'suggest',
      contactIds: who.map((contact) => contact.id),
      detail: hint,
      label: who[0] ? `Sugestão para ${who[0].name}` : 'Sugestão de resposta',
    }
  }

  if (/\b(resumo|resumir|resume)\b/i.test(text)) {
    const who = peopleAsked(original, contacts)
    const hint = who.length ? '' : askedName(original)
    return {
      type: 'text',
      assist: 'summary',
      contactIds: who.map((contact) => contact.id),
      detail: hint,
      label: who[0] ? `Resumo de ${who[0].name}` : 'Resumo da conversa',
    }
  }
  if (/n[aã]o lidas/i.test(text) && !/\bmarca/.test(text)) {
    return { type: 'text', assist: 'unread', contactIds: [], label: 'Não lidas' }
  }
  if (/\bquem me mandou\b/i.test(text) && /\b(áudio|audio)\b/i.test(text)) {
    return { type: 'text', assist: 'audio-today', contactIds: [], label: 'Áudios de hoje' }
  }
  if (/\b(o que chegou hoje|chegou hoje|mensagens de hoje)\b/i.test(text)) {
    return { type: 'text', assist: 'today', contactIds: [], label: 'O que chegou hoje' }
  }
  if (/\b(cad[eê]|onde est[aá]|procura|achar|busca)\b/i.test(text)) {
    const detail = searchTerms(original, 'cade|onde esta|procur\\p{L}*|achar|acha|busc\\p{L}*|encontr\\p{L}*', loose)
    return { ...base, type: 'text', assist: 'find', detail, label: detail ? `Buscar: ${detail}` : 'Buscar', contactIds: loose.map((contact) => contact.id) }
  }
  if (/\b(abre|abrir)\b/i.test(text) && (/\bconversa\b/i.test(text) || loose.length)) {
    return { type: 'text', assist: 'open', contactIds: loose.map((contact) => contact.id), label: 'Abrir conversa' }
  }
  if (/\b(gera o link|link do grupo|link de convite)\b/i.test(text)) {
    return { type: 'text', assist: 'group-link', contactIds: groupsNamed(original, contacts).map((group) => group.id), label: 'Link do grupo' }
  }
  if (/\badiciona\b/i.test(text) && !/\bfavorit/.test(text)) {
    const { person, contactIds } = memberCommand(original, contacts, loose)
    return {
      type: 'text',
      assist: 'group-add',
      contactIds,
      detail: person?.id || '',
      label: person ? `Adicionar ${person.name}` : 'Adicionar no grupo',
    }
  }
  if (/\b(tira dos favoritos|remover dos favoritos|tira o favorito)\b/i.test(text)) {
    return { ...base, type: 'unpin', label: 'Tirar dos favoritos' }
  }
  if (/\bfixa a [uú]ltima\b|\bfixar a [uú]ltima\b|\bfixa a mensagem\b/i.test(text)) {
    return { ...base, type: 'pinmsg', label: 'Fixar a última mensagem' }
  }

  if (!/\b(silencia|dessilencia|mutar|mute|notifica|tempor|desbloque|bloque|desarquiv|arquiv|desafix|fixa|favorit|lista|responde|reage|reagir|apaga|delet|manda|envia|export|pesquis|buscar|fechar conversa|dados do|selecionar mensag|tema\b|travar|cadeado|denunci|encaminh|estrela|edita|não lida|nao lida|limpar conversa|documento|contato|enquete|figurinha|gif)/i.test(text)) {
    return null
  }

  if (/\b(dessilencia\w*|ativar notifica\w*|unmute)\b/i.test(text)) {
    return { ...base, type: 'unmute', label: 'Ativar notificações' }
  }
  if (/\b(silencia\w*|mutar|mute)\b/i.test(text)) {
    const detail = /8\s*h|8\s*hora/i.test(text) ? '8h' : /semana|7\s*dia/i.test(text) ? '1w' : 'forever'
    const label = detail === '8h' ? 'Silenciar por 8 horas' : detail === '1w' ? 'Silenciar por 1 semana' : 'Silenciar notificações'
    return { ...base, type: 'mute', detail, label }
  }
  if (/\b(mensagens tempor|temporárias|temporarias)\b/i.test(text)) {
    const detail = /90/.test(text) ? '7776000' : /\b7\b|7\s*dia/.test(text) ? '604800' : /24/.test(text) ? '86400' : '0'
    const label =
      detail === '86400' ? 'Mensagens temporárias: 24 horas' : detail === '604800' ? 'Mensagens temporárias: 7 dias' : detail === '7776000' ? 'Mensagens temporárias: 90 dias' : 'Desligar mensagens temporárias'
    return { ...base, type: 'disappearing', detail, label }
  }
  if (/\bdesbloque\w*\b/i.test(text)) return { ...base, type: 'unblock', label: 'Desbloquear contato' }
  if (/\bbloque\w*\b/i.test(text)) return { ...base, type: 'block', label: 'Bloquear contato' }
  if (/\bdesarquiv\w*\b/i.test(text)) return { ...base, type: 'unarchive', label: 'Desarquivar conversa' }
  if (/\barquiv\w*\b/i.test(text)) return { ...base, type: 'archive', label: 'Arquivar conversa' }
  if (/\bdesafixar mensagem\b/i.test(text)) return { ...base, type: 'unpinmsg', label: 'Desafixar mensagem' }
  if (/\bfixar mensagem\b/i.test(text)) return { ...base, type: 'pinmsg', label: 'Fixar mensagem' }
  if (/\bdesafix\w*\b/i.test(text)) return { ...base, type: 'unpin', label: 'Desafixar conversa' }
  if (/\b(tirar a estrela|desestrela\w*)\b/i.test(text)) return { ...base, type: 'unstar', label: 'Tirar destaque' }
  if (/\b(estrela\w*|favoritar mensagem|destacar mensagem)\b/i.test(text)) return { ...base, type: 'star', label: 'Destacar mensagem' }
  if (/\b(fixa\w*|favorit\w*)\b/i.test(text)) return { ...base, type: 'pin', label: 'Adicionar aos favoritos' }
  if (/\blista\b/i.test(text)) {
    const name = original.replace(/^.*\blista\b\s*/i, '').trim()
    if (!name) return { ...base, type: 'label', detail: '', label: 'Lista' }
    return { ...base, type: 'label', detail: name, label: `Lista ${name}` }
  }
  if (/\b(responde\w*)\b/i.test(text)) {
    const { text: detail, recipients } = messageParts(original, 'respond\\p{L}*', contacts)
    return {
      type: 'reply',
      detail,
      contactIds: recipients.map((contact) => contact.id),
      label: detail ? `Responder: ${detail}` : 'Responder',
    }
  }
  if (/\b(reage\w*|reagir)\b/i.test(text)) {
    const emoji = original.match(/\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u)?.[0] || '👍'
    return { ...base, type: 'react', detail: emoji, label: `Reagir ${emoji}` }
  }
  if (/\b(apaga\w*|delet\w*)\b/i.test(text)) {
    const detail = /para mim|só para mim|so para mim/.test(text) ? 'me' : 'everyone'
    return { ...base, type: 'delete', detail, label: detail === 'me' ? 'Apagar para mim' : 'Apagar para todos' }
  }
  if (/\bedita\w*\b/i.test(text)) {
    const work = cutter(original)
    const verb = work.cut(words('edit\\p{L}*'))
    if (verb) work.cut(new RegExp(`^\\s*(?:(?:a\\s+)?(?:mensagem|ultima)${END}\\s*)?(?:(?:para|pra|por)${END})?`, 'u'), verb.start)
    const detail = tidy(work.raw)
    return { ...base, type: 'edit', detail, label: detail ? `Editar: ${detail}` : 'Editar mensagem' }
  }
  if (/\bencaminh\w*\b/i.test(text)) return { ...base, type: 'forward', label: 'Encaminhar' }
  if (/\b(não lida|nao lida)\b/i.test(text)) return { ...base, type: 'unread', label: 'Marcar como não lida' }
  if (/\blimpar conversa\b/i.test(text)) return { ...base, type: 'clear', label: 'Limpar conversa' }
  if (/\benquete\b/i.test(text)) {
    const detail = original.replace(/^.*\benquete\b\s*/i, '').trim()
    return { ...base, type: 'poll', detail, label: 'Enquete' }
  }
  if (/\b(manda\w*|envia\w*)\b/i.test(text) && /\bdocumento\b/i.test(text)) return { ...base, type: 'document', label: 'Enviar documento' }
  if (/\b(manda\w*|envia\w*)\b/i.test(text) && /\bfigurinha\b/i.test(text)) return { ...base, type: 'sticker', label: 'Enviar figurinha' }
  if (/\b(manda\w*|envia\w*)\b/i.test(text) && /\bgif\b/i.test(text)) return { ...base, type: 'gif', label: 'Enviar GIF' }
  if (/\b(manda\w*|envia\w*)\b/i.test(text) && /\bcontato\b/i.test(text)) {
    const parts = original.split(/\b(?:pro|pra|para)\b/i)
    const card = mentionedContacts(parts[0] || '', contacts)[0]
    const dest = parts.length > 1 ? mentionedContacts(parts.slice(1).join(' '), contacts) : []
    return {
      type: 'contact',
      contactIds: dest.map((person) => person.id),
      detail: card ? `${card.name}|${card.phone}` : '',
      label: card ? `Enviar contato ${card.name}` : 'Enviar contato',
    }
  }
  if (/\b(manda\w*|envia\w*)\b/i.test(text) && /(?:^|\P{L})(áudio|audio|voz)(?:$|\P{L})/iu.test(text)) {
    return { ...base, type: 'audio', label: 'Enviar áudio' }
  }
  if (/\b(manda\w*|envia\w*)\b/i.test(text) && /\b(vídeo|video)\b/i.test(text)) {
    return { ...base, type: 'video', label: 'Enviar vídeo' }
  }
  if (/\b(manda\w*|envia\w*)\b/i.test(text) && /\b(foto|imagem)\b/i.test(text)) {
    const { text: detail, recipients } = messageParts(original, SEND_VERB, contacts, [words('(?:(?:a|o|uma|um)\\s+)?(?:foto|imagem)')])
    return { type: 'photo', detail, contactIds: recipients.map((contact) => contact.id), label: 'Enviar foto' }
  }
  if (/\b(manda\w*|envia\w*)\b/i.test(text)) {
    let parts = messageParts(original, SEND_VERB, contacts)
    const phone = parts.recipients.length ? '' : phoneIn(original)
    if (phone) parts = messageParts(original, SEND_VERB, [], [PHONE])
    const detail = parts.text
    return {
      type: 'text',
      phone,
      detail,
      contactIds: parts.recipients.map((contact) => contact.id),
      label: detail ? `Enviar: ${detail}` : 'Enviar mensagem',
    }
  }
  if (/\b(link de chamada|chamada de voz)\b/i.test(text)) return { ...base, type: 'call', detail: 'voice', label: 'Enviar link de chamada' }
  if (/\b(nova chamada|chamada em grupo|chamada de vídeo|chamada de video)\b/i.test(text)) {
    return { ...base, type: 'call', detail: 'video', label: 'Nova chamada' }
  }
  if (/\b(dados do contato|info do contato|ver contato|dados do grupo)\b/i.test(text)) {
    const rest = original.replace(/\b(dados do contato|info do contato|ver contato|dados do grupo)\b/gi, ' ')
    const who = mentionedContacts(rest, contacts)
    return { type: 'text', local: 'info', contactIds: who.map((contact) => contact.id), label: 'Dados do contato' }
  }
  if (/\b(pesquis\w*|buscar)\b/i.test(text)) return { ...base, type: 'text', local: 'search', label: 'Pesquisar' }
  if (/\bselecionar mensag/i.test(text)) return { ...base, type: 'text', local: 'select', label: 'Selecionar mensagens' }
  if (/\bexport\w*\b/i.test(text)) return { ...base, type: 'text', local: 'export', label: 'Exportar conversa' }
  if (/\bfechar conversa\b/i.test(text)) return { ...base, type: 'text', local: 'close', label: 'Fechar conversa' }
  if (/\btema\b/i.test(text)) {
    const detail = /verde/.test(text) ? 'green' : /areia|claro/.test(text) ? 'sand' : /doodle|desenho/.test(text) ? 'doodle' : /escuro|padr[aã]o/.test(text) ? 'default' : ''
    return { ...base, type: 'text', local: 'theme', detail, label: 'Tema da conversa' }
  }
  if (/\b(travar|cadeado|lock)\b/i.test(text)) return { ...base, type: 'text', local: 'lock', label: 'Travar conversa' }
  if (/\b(denunci\w*|reportar)\b/i.test(text)) return { ...base, type: 'text', local: 'report', label: 'Denunciar' }
  return null
}

export const ASSISTANT_GUIDE: { title: string; examples: string[] }[] = [
  {
    title: 'Ver',
    examples: ['o que você faz', 'resume a conversa', 'o que ficou pendente', 'sugere uma resposta', 'mostra as não lidas', 'o que chegou hoje', 'quem me mandou áudio hoje', 'cadê o pix do Pedro', 'quem postou status'],
  },
  {
    title: 'Conversas',
    examples: ['abre a Ana', 'fala com 11999999999', 'marca como lida', 'arquiva a conversa', 'silencia esse grupo por uma semana', 'adiciona aos favoritos', 'lista Trabalho'],
  },
  {
    title: 'Mensagens',
    examples: ['responde que chego às 8', 'manda oi pra Ana', 'reage com 👍', 'apaga a última', 'edita para bom dia', 'encaminha pra Ana', 'enquete Almoço | pizza | sushi'],
  },
  {
    title: 'Grupo',
    examples: ['adiciona o Bruno', 'remove o Bruno do grupo', 'promove o Bruno', 'rebaixa o Bruno', 'gera o link', 'muda o nome para Família', 'descrição do grupo: avisos', 'muda a foto do grupo', 'sai do grupo'],
  },
  {
    title: 'Conta',
    examples: ['posta um status: bom dia', 'trava o app 1234', 'sair do WhatsApp'],
  },
]

export function assistantHelp() {
  return 'Abro conversa, resumo, mostro não lidas e mando com @nome. O que envia mensagem só sai depois que você confirma.'
}

export function closestExample(input: string) {
  const words = input
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2)
  let best = 'o que você faz'
  let score = 0
  for (const section of ASSISTANT_GUIDE) {
    for (const example of section.examples) {
      const hay = example
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
      const next = words.reduce((total, word) => total + (hay.includes(word) ? 1 : 0), 0)
      if (next > score) {
        score = next
        best = example
      }
    }
  }
  return best
}

export const LOCAL_NOTES: Record<LocalCommand, string> = {
  info: 'Abri os dados da conversa.',
  search: 'Abri a pesquisa nesta conversa.',
  close: 'Conversa fechada.',
  export: 'Exportei as mensagens carregadas.',
  select: 'Modo de seleção ligado. Toque nas mensagens.',
  theme: 'Tema da conversa atualizado.',
  lock: 'Conversa travada neste aparelho.',
  report: 'Denúncia enviada.',
}
