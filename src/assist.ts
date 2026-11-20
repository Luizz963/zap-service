import type { ChatMessage, Contact } from './types'

export function startOfToday() {
  const date = new Date()
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

const PENDING_CUE = /(?:\?|amanh[ãa]|hoje|preciso|precisa|me manda|manda o|combina|depois|pendente|n[aã]o esquece|\b[àa]s\s+\d)/i

function clip(value: string, size = 120) {
  const text = value.replace(/\s+/g, ' ').trim()
  if (text.length <= size) return text
  return `${text.slice(0, size - 1).trim()}…`
}

function joinList(items: string[]) {
  if (items.length <= 1) return items[0] || ''
  if (items.length === 2) return `${items[0]} e ${items[1]}`
  return `${items.slice(0, -1).join(', ')} e ${items.at(-1)}`
}

function said(message: ChatMessage, name: string) {
  const who = message.fromMe ? 'você' : message.authorName || name
  const text = clip(message.text || message.filename || message.kind || 'uma mensagem')
  return `${who} disse “${text}”`
}

export function pendingDigest(name: string, messages: ChatMessage[]) {
  const rows = messages.filter((item) => PENDING_CUE.test(item.text || '')).slice(-4)
  if (!rows.length) return `Em ${name} não vi nada pendente nas mensagens carregadas.`
  const lines = rows.map((item) => said(item, name))
  return `Em ${name}, o que parece pendente é isto: ${joinList(lines)}.`
}

export function suggestReply(messages: ChatMessage[]) {
  const last = [...messages].reverse().find((item) => !item.fromMe && (item.text || '').trim())
  if (!last) return ''
  const text = last.text.trim()
  if (/\?/.test(text)) return 'Deixa eu ver e te falo.'
  if (/obrigad/i.test(text)) return 'Por nada.'
  if (/bom dia/i.test(text)) return 'Bom dia.'
  if (/boa tarde/i.test(text)) return 'Boa tarde.'
  if (/boa noite/i.test(text)) return 'Boa noite.'
  if (/^(oi|ol[aá]|e a[ií]|eai|fala)\b/i.test(text)) return 'Oi, tudo bem?'
  return 'Vi aqui. Te retorno em seguida.'
}

export function summarizeChat(name: string, messages: ChatMessage[]) {
  if (!messages.length) return `${name} ainda não tem mensagens carregadas. Abre a conversa que eu te conto o que está lá.`
  const today = messages.filter((item) => item.at >= startOfToday()).length
  const recent = messages.slice(-3).map((item) => said(item, name))
  const todayBit = today ? `, ${today} de hoje` : ''
  return `Com ${name} eu vi ${messages.length} ${messages.length === 1 ? 'mensagem' : 'mensagens'}${todayBit}. No fim, ${joinList(recent)}.`
}

export function unreadDigest(contacts: Contact[]) {
  const rows = contacts.filter((item) => (item.unread ?? 0) > 0 && !item.archived)
  if (!rows.length) return { text: 'Nenhuma conversa está não lida.', ids: [] as string[] }
  const shown = rows.slice(0, 6)
  const bits = shown.map((item) => ((item.unread ?? 0) > 1 ? `${item.name}, com ${item.unread}` : item.name))
  const more = rows.length > shown.length ? `, e mais ${rows.length - shown.length}` : ''
  return {
    text: `Tem mensagem não lida com ${joinList(bits)}${more}.`,
    ids: shown.map((item) => item.id),
  }
}

export function todayDigest(contacts: Contact[], messagesByContact: Record<string, ChatMessage[]>, audioOnly = false) {
  const start = startOfToday()
  const lines: string[] = []
  const ids: string[] = []
  const ranked = [...contacts].sort((a, b) => b.lastAt - a.lastAt)
  for (const contact of ranked) {
    const rows = (messagesByContact[contact.id] ?? []).filter(
      (item) => item.at >= start && (!audioOnly || (item.kind === 'audio' && !item.fromMe)),
    )
    if (!rows.length) {
      if (audioOnly || contact.lastAt < start) continue
      lines.push(contact.name)
      ids.push(contact.id)
    } else {
      const last = rows.at(-1)!
      const who = last.fromMe ? 'você' : last.authorName || contact.name
      const bit = clip(last.text || last.kind || 'uma mensagem', 80)
      lines.push(audioOnly ? `${who} mandou áudio em ${contact.name}` : `${contact.name}, em que ${who} disse “${bit}”`)
      ids.push(contact.id)
    }
    if (lines.length >= 6) break
  }
  if (!lines.length) {
    return {
      text: audioOnly
        ? 'Ninguém te mandou áudio hoje nas conversas já abertas.'
        : 'Nas conversas carregadas, não chegou nada hoje.',
      ids,
    }
  }
  return {
    text: audioOnly ? `Áudio de hoje: ${joinList(lines)}.` : `Hoje passou por ${joinList(lines)}.`,
    ids,
  }
}

const QUESTION_START = /^(o que|oq|qual|quais|quem|como|por\s*que|porque|pq|quando|onde|cad[eê]|ser[aá] que|tem como|d[aá] pra|pode|consegue|voc[eê] sabe|me explica|explica|me fala|me diz|me conta)\b/i

export function isQuestion(input: string) {
  const text = input.trim()
  if (!text) return false
  if (/\?\s*$/.test(text)) return true
  return QUESTION_START.test(text)
}

type AnswerContext = {
  contacts: Contact[]
  messagesByContact: Record<string, ChatMessage[]>
  active: Contact | null
  people: Contact[]
}

const UNKNOWN = 'Não posso ajudar com isso.'

function subjectOf(ctx: AnswerContext) {
  return ctx.people[0] || ctx.active
}

function lastFromThem(messages: ChatMessage[]) {
  return [...messages].reverse().find((item) => !item.fromMe && (item.text || '').trim())
}

function basicFact(text: string, contact: Contact | null, messages: ChatMessage[]) {
  if (/\b(crie|cria|criar|defina|define|manda|envie|envia|abre|abrir|silencia|arquiva|adiciona|remove|apaga)\b/i.test(text)) return null
  if (/\b(seu nome|voc[eê] se chama)\b/i.test(text)) return 'Eu sou o assistente.'
  if (/\b(qual o nome|o nome d(ele|ela|o|da|esse|essa)|como se chama|quem se chama)\b/i.test(text)) {
    if (!contact) return null
    return `O nome é ${contact.name}.`
  }
  if (/\b(telefone|n[uú]mero|celular)\b/i.test(text)) {
    if (!contact?.phone) return null
    return `O número é ${contact.phone}.`
  }
  if (/\bgrupo\b/i.test(text) && /\b([eé]|isso|ele|ela|esse|essa)\b/i.test(text)) {
    if (!contact) return null
    return contact.isGroup ? `${contact.name} é um grupo.` : `${contact.name} não é um grupo.`
  }
  if (/\bquem [eé] (ele|ela|esse|essa)\b/i.test(text)) {
    if (!contact) return null
    return `É ${contact.name}.`
  }
  if (/\b(falou|disse|escreveu|mandou|última|ultima)\b/i.test(text)) {
    if (!contact) return null
    const last = lastFromThem(messages)
    if (!last?.text) return null
    return `${contact.name} disse “${clip(last.text)}”.`
  }
  if (/\b(resumo|resumir|resume)\b/i.test(text)) {
    if (!contact) return null
    return summarizeChat(contact.name, messages)
  }
  return null
}

function basicWorld(text: string) {
  if (/^(oi|ol[aá]|eai|e a[ií]|bom dia|boa tarde|boa noite|tudo bem)\b/i.test(text)) return 'Oi. Pode perguntar ou pedir uma ação.'
  if (/\b(que horas|horas s[aã]o|hora agora)\b/i.test(text)) {
    const hour = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(new Date())
    return `Agora são ${hour}.`
  }
  if (/\b(que dia|dia [eé] hoje|data de hoje)\b/i.test(text)) {
    const day = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date())
    return `Hoje é ${day}.`
  }
  const math = text.replace(/,/g, '.').match(/(-?\d+(?:\.\d+)?)\s*([+\-x×*/])\s*(-?\d+(?:\.\d+)?)/)
  if (math && /\b(quanto|calcula|soma|vezes)\b/i.test(text)) {
    const left = Number(math[1])
    const right = Number(math[3])
    const op = math[2]
    if (op === '+') return `Dá ${left + right}.`
    if (op === '-') return `Dá ${left - right}.`
    if (op === '*' || op === 'x' || op === '×') return `Dá ${left * right}.`
    if (!right) return null
    return `Dá ${left / right}.`
  }
  return null
}

export function instantAnswer(text: string) {
  return basicWorld(text) || basicFact(text, null, [])
}

function searchLoaded(query: string, contacts: Contact[], messagesByContact: Record<string, ChatMessage[]>) {
  const needle = query.toLowerCase()
  const hits: { id: string; name: string; text: string }[] = []
  for (const contact of contacts) {
    for (const message of messagesByContact[contact.id] ?? []) {
      const text = message.text || ''
      if (!text || !text.toLowerCase().includes(needle)) continue
      hits.push({ id: contact.id, name: contact.name, text: clip(text) })
      if (hits.length >= 3) return hits
    }
  }
  return hits
}

export function answerQuestion(input: string, ctx: AnswerContext) {
  const text = input.trim()
  const ids = ctx.people.map((person) => person.id)
  const contact = subjectOf(ctx)
  const messages = contact ? ctx.messagesByContact[contact.id] ?? [] : []

  if (/\b(o que voc[eê] faz|o que voc[eê] sabe|como voc[eê] funciona|quem [eé] voc[eê]|quais comandos|o que d[aá] pra)\b/i.test(text)) {
    return {
      text: 'Eu sou o assistente deste WhatsApp. Respondo pergunta básica e executo ação na conversa.',
      ids: [] as string[],
    }
  }

  const world = basicWorld(text)
  if (world) return { text: world, ids: [] as string[] }

  const fact = basicFact(text, contact, messages)
  if (fact) return { text: fact, ids: contact ? [contact.id] : [] }

  if (/n[aã]o lidas/i.test(text) && !/\bmarca/.test(text)) {
    const digest = unreadDigest(ctx.contacts)
    return { text: digest.text, ids: digest.ids }
  }

  if (/\b(o que chegou hoje|chegou hoje|mensagens de hoje)\b/i.test(text)) {
    const digest = todayDigest(ctx.contacts, ctx.messagesByContact)
    return { text: digest.text, ids: digest.ids }
  }

  if (/\bquem me mandou\b/i.test(text) && /\b(áudio|audio)\b/i.test(text)) {
    const digest = todayDigest(ctx.contacts, ctx.messagesByContact, true)
    return { text: digest.text, ids: digest.ids }
  }

  let looked = text.replace(QUESTION_START, ' ')
  for (const person of ctx.people) {
    looked = looked.replace(new RegExp(person.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ')
    const first = person.name.split(/\s+/)[0] ?? ''
    if (first.length >= 3) looked = looked.replace(new RegExp(`\\b${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig'), ' ')
  }
  looked = looked
    .replace(/\b(o|a|os|as|de|do|da|no|na|em|um|uma|que|me|pra|pro|para|com|por|favor|pfv|falou|disse|mensagem|conversa|est[aá]|fica|ficou)\b/gi, ' ')
    .replace(/[?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (looked.length >= 3 && /\b(cad[eê]|onde|procura|achar|busca)\b/i.test(text)) {
    const pool = ctx.people.length ? ctx.people : ctx.contacts
    const hits = searchLoaded(looked, pool, ctx.messagesByContact)
    if (!hits.length) return { text: `Não achei “${looked}” nas mensagens carregadas.`, ids }
    const first = hits[0]!
    const extra = hits.length - 1
    return {
      text: extra
        ? `Achei “${looked}” com ${first.name}: “${first.text}”. Tem mais ${extra} ${extra === 1 ? 'ocorrência' : 'ocorrências'}.`
        : `Achei “${looked}” com ${first.name}: “${first.text}”.`,
      ids: [...new Set(hits.map((hit) => hit.id))],
    }
  }

  if (ctx.people.length === 1 && contact && isQuestion(text)) {
    const last = lastFromThem(messages)
    return {
      text: last?.text ? `${contact.name}. A última mensagem dele foi “${clip(last.text)}”.` : `O nome é ${contact.name}.`,
      ids,
    }
  }

  return { text: UNKNOWN, ids: [] as string[] }
}
