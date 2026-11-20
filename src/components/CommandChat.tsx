import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { formatClock } from '../format'
import { AtIcon, AttachIcon, CloseIcon, MicIcon, SendIcon, UsersIcon } from '../icons'
import { answerQuestion, instantAnswer, pendingDigest, suggestReply, summarizeChat, todayDigest, unreadDigest } from '../assist'
import { request } from '../api'
import { LOCAL_NOTES, assistantHelp, closestExample, fold, looseContacts, messageMentions, parseCommand, type ParsedCommand } from '../commands'
import { useStore } from '../store'
import type { CommandAction, CommandFile, Contact } from '../types'

const MAX_FILE_BYTES = 20 * 1024 * 1024

const ACTIONS: { id: CommandAction; label: string }[] = [
  { id: 'text', label: 'Texto' },
  { id: 'photo', label: 'Foto' },
  { id: 'audio', label: 'Áudio' },
  { id: 'group', label: 'Grupo' },
]

function mentionQuery(value: string, caret: number) {
  const before = value.slice(0, caret)
  const match = before.match(/@([^\s@]*)$/)
  if (!match || match.index === undefined) return null
  return { start: match.index, query: match[1] }
}

function readFile(file: File): Promise<CommandFile> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const comma = result.indexOf(',')
      resolve({
        name: file.name,
        mimetype: file.type || 'application/octet-stream',
        data: comma >= 0 ? result.slice(comma + 1) : result,
      })
    }
    reader.onerror = () => reject(new Error('Falha ao ler o arquivo'))
    reader.readAsDataURL(file)
  })
}

function detectAction(action: CommandAction, input: string, file: CommandFile | null): CommandAction {
    if (file?.mimetype.startsWith('image/')) return 'photo'
    if (file?.mimetype.startsWith('audio/')) return 'audio'
    if (file?.mimetype.startsWith('video/')) return 'video'
  if (/^(criar grupo|novo grupo|\/grupo)\b/i.test(input.trim())) return 'group'
  return action
}

type AgentDecision =
  | { kind: 'answer'; text: string }
  | { kind: 'action'; action: string; contacts: string[]; text: string; detail: string }

function placeholderFor(action: CommandAction, hasContacts: boolean) {
  if (action === 'group') {
    return hasContacts ? 'Nome do grupo, tipo: Família' : 'Marque os contatos com @ e digite o nome do grupo'
  }
  if (action === 'photo') {
    return hasContacts ? 'Legenda opcional da foto...' : 'Marque os contatos com @ e anexe uma foto'
  }
  if (action === 'audio') {
    return hasContacts ? 'Áudio vai como recado de voz' : 'Marque os contatos com @ e anexe um áudio'
  }
  return hasContacts
    ? 'Pergunta ou ação, tipo: que horas são'
    : 'Pergunta ou ação, tipo: que horas são'
}

export function CommandChat() {
  const {
    contacts,
    photos,
    messagesByContact,
    commandMessages,
    runCommand,
    setActiveContactId,
    requestUi,
    requestBrowse,
    noteCommand,
    activeContactId,
    pickedIds,
    status,
    blasting,
    searchAll,
    openNumber,
    groupAction,
    ensureThread,
    askConfirm,
    loadStatuses,
    postStatus,
    lockApp,
    logout,
  } = useStore()
  const ready = status === 'ready'
  const [selected, setSelected] = useState<Contact[]>([])
  const [input, setInput] = useState('')
  const [caret, setCaret] = useState(0)
  const [openPicker, setOpenPicker] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [error, setError] = useState('')
  const [action, setAction] = useState<CommandAction>('text')
  const [file, setFile] = useState<CommandFile | null>(null)
  const [draggingFile, setDraggingFile] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const focusRef = useRef('')
  const fileRef = useRef<HTMLInputElement>(null)
  const logRef = useRef<HTMLDivElement>(null)

  const activeMention = mentionQuery(input, caret)
  const pickerOpen = openPicker || Boolean(activeMention)

  const available = useMemo(() => {
    const taken = new Set(selected.map((contact) => contact.id))
    const needle = (activeMention?.query ?? '').toLowerCase()
    return contacts.filter((contact) => {
      if (taken.has(contact.id)) return false
      if (action === 'group' && contact.isGroup) return false
      if (!needle) return true
      return contact.name.toLowerCase().includes(needle) || contact.phone.includes(needle)
    })
  }, [contacts, selected, activeMention, action])

  useEffect(() => {
    setHighlight(0)
  }, [available.length, pickerOpen, activeMention?.query])

  useEffect(() => {
    const node = logRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [commandMessages.length])

  function addContact(contact: Contact) {
    setSelected((prev) => (prev.some((item) => item.id === contact.id) ? prev : [...prev, contact]))
    if (activeMention) {
      const next = `${input.slice(0, activeMention.start)}${input.slice(caret)}`.replace(/\s+$/, ' ')
      setInput(next.trimStart())
    }
    setOpenPicker(false)
    setError('')
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  function removeContact(id: string) {
    setSelected((prev) => prev.filter((contact) => contact.id !== id))
  }

  async function onPickFile(picked: File | undefined) {
    if (!picked) return
    if (picked.size > MAX_FILE_BYTES) {
      setError('Arquivo grande demais (máx. 20 MB)')
      return
    }
    try {
      const parsed = await readFile(picked)
      setFile(parsed)
      if (parsed.mimetype.startsWith('image/')) setAction('photo')
      if (parsed.mimetype.startsWith('audio/')) setAction('audio')
      setError('')
    } catch {
      setError('Não deu pra ler esse arquivo')
    }
  }

  function remember(id?: string) {
    if (id) focusRef.current = id
  }

  function confirmNote(said: string, question: string, contactIds: string[], task: () => Promise<string>) {
    askConfirm(question, async () => {
      try {
        noteCommand(said, await task(), contactIds)
      } catch (caught) {
        noteCommand(said, caught instanceof Error ? caught.message : 'Não deu pra fazer isso', contactIds)
      }
    })
  }

  async function runFind(said: string, query: string) {
    const term = query.trim()
    if (term.length < 2) throw new Error('Diga o que procurar, tipo: cadê o pix do Pedro')
    let hits = await searchAll(term)
    if (!hits.length) {
      const needle = term.toLowerCase()
      hits = []
      for (const contact of contacts) {
        const message = (messagesByContact[contact.id] ?? []).find((item) => (item.text || '').toLowerCase().includes(needle))
        if (!message) continue
        hits.push({
          contactId: contact.id,
          contactName: contact.name,
          messageId: message.id,
          text: message.text,
          at: message.at,
        })
      }
    }
    if (!hits.length) {
      noteCommand(said, `Não achei “${term}” nas mensagens carregadas.`, [])
      return
    }
    const first = hits[0]!
    remember(first.contactId)
    setActiveContactId(first.contactId)
    requestUi('search', first.contactId, term)
    const extra = hits.length - 1
    noteCommand(
      said,
      extra
        ? `Achei “${term}” com ${first.contactName}: “${first.text}”. Tem mais ${extra} ${extra === 1 ? 'ocorrência' : 'ocorrências'}.`
        : `Achei “${term}” com ${first.contactName}: “${first.text}”.`,
      [...new Set(hits.slice(0, 3).map((hit) => hit.contactId))],
    )
  }

  async function runAssist(parsed: ParsedCommand, attached: CommandFile | null, said: string) {
    const active = contacts.find((contact) => contact.id === activeContactId) ?? null
    const namedGroup = parsed.contactIds
      .map((id) => contacts.find((contact) => contact.id === id))
      .find((contact) => contact?.isGroup)
    const groupId = namedGroup?.id || (active?.isGroup ? active.id : '')
    // Shown in every group confirmation, so a wrong target is obvious before anything changes.
    const groupName = `“${contacts.find((contact) => contact.id === groupId)?.name || 'grupo'}”`

    if (parsed.assist === 'summary' || parsed.assist === 'pending' || parsed.assist === 'suggest') {
      const named = contacts.find((contact) => parsed.contactIds.includes(contact.id))
      if (!named && parsed.detail) throw new Error(`Não achei ${parsed.detail} na sua lista`)
      const contact = named || active
      if (!contact) throw new Error('Abra a conversa ou diga o nome, tipo: resume a conversa do Kadu')
      const messages = await ensureThread(contact.id)
      if (parsed.assist === 'summary') {
        noteCommand(said, summarizeChat(contact.name, messages), [contact.id])
        return
      }
      if (parsed.assist === 'pending') {
        noteCommand(said, pendingDigest(contact.name, messages), [contact.id])
        return
      }
      const draft = suggestReply(messages)
      if (!draft) throw new Error('Não tem mensagem recebida carregada pra sugerir')
      await runCommand({ type: 'reply', contactIds: [contact.id], text: draft, said })
      return
    }
    if (parsed.assist === 'focus-open') {
      const id = focusRef.current || activeContactId || ''
      const contact = contacts.find((item) => item.id === id)
      if (!contact) throw new Error('Ainda não tem uma conversa recente. Busque ou abra alguém antes.')
      remember(contact.id)
      setActiveContactId(contact.id)
      noteCommand(said, `Abri ${contact.name}.`, [contact.id])
      return
    }
    if (parsed.assist === 'focus-reply') {
      const id = focusRef.current || activeContactId || ''
      const contact = contacts.find((item) => item.id === id)
      if (!contact) throw new Error('Diga em qual conversa, ou busque alguém antes.')
      if (!parsed.detail?.trim()) throw new Error('Diga a resposta, tipo: responde nessa que chego às 8')
      remember(contact.id)
      await runCommand({ type: 'reply', contactIds: [contact.id], text: parsed.detail.trim(), said })
      return
    }
    if (parsed.assist === 'unread') {
      const digest = unreadDigest(contacts)
      requestBrowse('unread')
      remember(digest.ids[0])
      noteCommand(said, digest.text, digest.ids)
      return
    }
    if (parsed.assist === 'today' || parsed.assist === 'audio-today') {
      const digest = todayDigest(contacts, messagesByContact, parsed.assist === 'audio-today')
      if (parsed.assist === 'today') requestBrowse('today')
      remember(digest.ids[0])
      noteCommand(said, digest.text, digest.ids)
      return
    }
    if (parsed.assist === 'find') {
      await runFind(said, parsed.detail?.trim() || '')
      return
    }
    if (parsed.assist === 'open') {
      const contact = contacts.find((item) => item.id === parsed.contactIds[0])
      if (!contact && parsed.detail) throw new Error(`Não achei ${parsed.detail} na sua lista`)
      const named = contact || contacts.find((item) => item.id === (focusRef.current || activeContactId || ''))
      if (!named) throw new Error('Não achei essa conversa. Diga o nome, tipo: abre a Ana e responde que chego às 8')
      remember(named.id)
      setActiveContactId(named.id)
      noteCommand(said, `Abri ${named.name}.`, [named.id])
      if (parsed.thenReply?.trim()) {
        await runCommand({ type: 'reply', contactIds: [named.id], text: parsed.thenReply.trim(), said, quiet: true })
      }
      return
    }
    if (parsed.phone) {
      const contact = await openNumber(parsed.phone)
      if (!contact) throw new Error('Esse número não está no WhatsApp')
      if (!parsed.detail?.trim()) {
        noteCommand(said, `Abri +${parsed.phone}.`, [contact.id])
        return
      }
      await runCommand({ type: 'text', contactIds: [contact.id], text: parsed.detail, said })
      return
    }
    if (parsed.assist === 'group-link') {
      if (!groupId) throw new Error('Abra o grupo ou diga o nome dele')
      const link = await groupAction({ contactId: groupId, action: 'invite' })
      noteCommand(said, link, [groupId])
      return
    }
    if (parsed.assist === 'group-rename') {
      if (!groupId) throw new Error('Abra o grupo')
      if (!parsed.detail?.trim()) throw new Error('Diga o nome, tipo: muda o nome para Família')
      const name = parsed.detail.trim()
      confirmNote(said, `Mudar o nome de ${groupName} para “${name.slice(0, 100)}”?`, [groupId], () =>
        groupAction({ contactId: groupId, action: 'subject', text: name }),
      )
      return
    }
    if (parsed.assist === 'group-create') {
      const name = parsed.detail?.trim() || ''
      const members = parsed.contactIds
        .map((id) => contacts.find((contact) => contact.id === id))
        .filter((contact): contact is Contact => Boolean(contact))
      if (!name) throw new Error('Diga o nome do grupo, tipo: cria um grupo Viagem com a Ana e o Pedro')
      if (!members.length) throw new Error('Diga quem entra, tipo: cria um grupo Viagem com a Ana e o Pedro')
      askConfirm(`Criar o grupo “${name}” com ${members.map((person) => person.name).join(' e ')}?`, async () => {
        await runCommand({ type: 'group', contactIds: members.map((person) => person.id), text: name, said, quiet: true })
      })
      return
    }
    if (parsed.assist === 'group-add') {
      const person = contacts.find((contact) => contact.id === parsed.detail && !contact.isGroup)
      if (!groupId) throw new Error('Abra o grupo e diga quem entra, tipo: adiciona o Bruno')
      if (!person) throw new Error('Não achei essa pessoa na sua lista')
      confirmNote(said, `Adicionar ${person.name} ao grupo ${groupName}?`, [groupId, person.id], () =>
        groupAction({ contactId: groupId, action: 'add', participantId: person.id }),
      )
      return
    }
    if (parsed.assist === 'help') {
      noteCommand(said, assistantHelp(), [])
      return
    }
    if (parsed.assist === 'statuses') {
      const rows = await loadStatuses()
      const shown = rows.slice(0, 6)
      const bits = shown.map((row) => (row.text ? `${row.name} (“${row.text.slice(0, 80)}”)` : row.name))
      noteCommand(said, shown.length ? `Status de ${bits.slice(0, -1).join(', ')}${bits.length > 1 ? ' e ' : ''}${bits.at(-1)}.` : 'Nenhum status carregado.', [])
      return
    }
    if (parsed.assist === 'status-post') {
      const text = parsed.detail?.trim() || ''
      if (!text && !attached) throw new Error('Diga o texto, tipo: posta um status: bom dia')
      confirmNote(said, text ? `Publicar este status? “${text.slice(0, 140)}”` : 'Publicar este status?', [], () => postStatus(text, attached ?? undefined))
      return
    }
    if (parsed.assist === 'mark-read') {
      const named = contacts.find((item) => item.id === parsed.contactIds[0]) || active
      if (!named) throw new Error('Abra a conversa ou diga o nome, tipo: marca a Ana como lida')
      remember(named.id)
      setActiveContactId(named.id)
      noteCommand(said, `Marquei ${named.name} como lida.`, [named.id])
      return
    }
    if (parsed.assist === 'group-leave') {
      if (!groupId) throw new Error('Abra o grupo ou diga o nome dele')
      confirmNote(said, `Sair do grupo ${groupName}?`, [groupId], () => groupAction({ contactId: groupId, action: 'leave' }))
      return
    }
    if (parsed.assist === 'group-description') {
      if (!groupId) throw new Error('Abra o grupo')
      if (!parsed.detail?.trim()) throw new Error('Diga a descrição, tipo: descrição do grupo: avisos da semana')
      const text = parsed.detail.trim()
      confirmNote(said, `Mudar a descrição de ${groupName} para “${text.slice(0, 140)}”?`, [groupId], () =>
        groupAction({ contactId: groupId, action: 'description', text }),
      )
      return
    }
    if (parsed.assist === 'group-picture') {
      if (!groupId) throw new Error('Abra o grupo')
      if (!attached) throw new Error('Anexe a foto e peça de novo: muda a foto do grupo')
      const photo = attached
      confirmNote(said, `Trocar a foto do grupo ${groupName}?`, [groupId], () => groupAction({ contactId: groupId, action: 'picture', file: photo }))
      return
    }
    if (parsed.assist === 'group-remove' || parsed.assist === 'group-promote' || parsed.assist === 'group-demote') {
      const person = contacts.find((contact) => contact.id === parsed.detail && !contact.isGroup)
      const action = parsed.assist === 'group-remove' ? 'remove' : parsed.assist === 'group-promote' ? 'promote' : 'demote'
      const verb = action === 'remove' ? 'Remover' : action === 'promote' ? 'Promover' : 'Rebaixar'
      if (!groupId) throw new Error('Abra o grupo ou diga o nome dele')
      if (!person) throw new Error(`Diga quem, tipo: ${verb.toLowerCase()} o Bruno`)
      confirmNote(said, `${verb} ${person.name} ${action === 'remove' ? 'do' : 'no'} grupo ${groupName}?`, [groupId, person.id], () =>
        groupAction({ contactId: groupId, action, participantId: person.id }),
      )
      return
    }
    if (parsed.assist === 'lock-app') {
      if (!parsed.detail || !/^\d{4}$/.test(parsed.detail)) throw new Error('Diga o PIN de 4 dígitos, tipo: trava o app 1234')
      if (!lockApp(parsed.detail)) throw new Error('PIN diferente do que já está salvo neste aparelho')
      noteCommand(said, 'App travado.', [])
      return
    }
    if (parsed.assist === 'logout') {
      confirmNote(said, 'Sair do WhatsApp neste aparelho?', [], async () => {
        logout()
        return 'Desconectei. O QR novo aparece quando o WhatsApp abrir de novo.'
      })
    }
  }

  async function askModel(template: string) {
    const ranked = [...contacts].sort((a, b) => b.lastAt - a.lastAt)
    const named = ranked.filter((contact) => {
      const first = contact.name.trim().split(/\s+/)[0] ?? ''
      return first.length >= 3 && template.toLowerCase().includes(first.toLowerCase())
    })
    const pool = [...named, ...ranked]
      .filter((contact, index, list) => list.findIndex((item) => item.id === contact.id) === index)
      .slice(0, 80)
    const active = contacts.find((contact) => contact.id === activeContactId) ?? null
    const recent = active
      ? (messagesByContact[active.id] ?? []).slice(-6).map((message) => ({
          from: message.fromMe ? 'você' : message.authorName || active.name,
          text: (message.text || message.kind || '').replace(/\s+/g, ' ').slice(0, 140),
        }))
      : []
    // The server retries up to 3 models with a 45s timeout each, so give it room before giving up.
    const result = await request<{ missing?: boolean; decision?: AgentDecision }>(
      'decide',
      {
        text: template,
        active: active ? { name: active.name, group: active.isGroup } : null,
        recent,
        contacts: pool.map((contact) => ({ name: contact.name, group: contact.isGroup })),
      },
      300_000,
    )
    if (result.missing) return null
    if (!result.ok || !result.decision) throw new Error(result.error || 'O modelo não respondeu')
    return result.decision
  }

  async function applyDecision(said: string, decision: AgentDecision) {
    if (decision.kind === 'answer') {
      // A bare "can't help" is a dead end; point to the closest command the assistant does know.
      const declined = /^n[aã]o posso ajudar/i.test(decision.text.trim())
      noteCommand(said, declined ? `Não entendi esse pedido. Tente algo como: “${closestExample(said)}”` : decision.text, [])
      return
    }
    const people: Contact[] = []
    for (const name of decision.contacts) {
      const hit = looseContacts(name, contacts)[0]
      if (hit && !people.some((item) => item.id === hit.id)) people.push(hit)
    }
    const active = contacts.find((contact) => contact.id === activeContactId) ?? null
    const target = people[0]?.id || active?.id || ''
    const named = people[0] || active
    if (decision.action === 'close' || decision.action === 'info' || decision.action === 'open' || decision.action === 'mark-read') {
      if (!target || !named) throw new Error('Não achei essa conversa')
      if (decision.action === 'close') {
        requestUi('close', target)
        noteCommand(said, 'Conversa fechada.', [target])
        return
      }
      if (decision.action === 'info') {
        requestUi('info', target)
        noteCommand(said, 'Abri os dados da conversa.', [target])
        return
      }
      setActiveContactId(target)
      noteCommand(said, decision.action === 'mark-read' ? `Marquei ${named.name} como lida.` : `Abri ${named.name}.`, [target])
      return
    }
    if (decision.action === 'search') {
      await runFind(said, decision.text || '')
      return
    }
    if (decision.action === 'create-group') {
      const members = people.filter((person) => !person.isGroup)
      if (!decision.text) throw new Error('Faltou o nome do grupo')
      if (!members.length) throw new Error('Não achei quem entra no grupo')
      askConfirm(`Criar o grupo “${decision.text}” com ${members.map((person) => person.name).join(' e ')}?`, async () => {
        await runCommand({
          type: 'group',
          contactIds: members.map((person) => person.id),
          text: decision.text,
          said,
          quiet: true,
        })
      })
      return
    }
    const chatAction = ['mute', 'unmute', 'archive', 'unarchive', 'pin', 'unpin', 'send', 'reply'].includes(decision.action)
    if (!chatAction) {
      noteCommand(said, 'Não posso ajudar com isso.', [])
      return
    }
    const contactIds = people.length ? people.map((person) => person.id) : target ? [target] : []
    if (!contactIds.length) throw new Error('Não achei essa conversa')
    if (decision.action === 'send' || decision.action === 'reply') {
      // The model can only send text. A photo/file request, or an empty text, must not become a blank message.
      if (/\b(foto|imagem|figurinha|video|audio|arquivo|documento|pdf|gif)\b/.test(fold(said))) {
        throw new Error('Para mandar foto ou arquivo, anexe pelo 📎 aqui embaixo e escreva, tipo: manda foto pro André')
      }
      if (!decision.text.trim()) throw new Error('Diga o que enviar, tipo: manda oi pro André')
    }
    await runCommand({
      type: decision.action === 'reply' ? 'reply' : decision.action === 'send' ? 'text' : (decision.action as CommandAction),
      contactIds,
      text: decision.action === 'mute' ? (decision.detail === '8h' || decision.detail === '1w' ? decision.detail : 'forever') : decision.text,
      said,
    })
  }

  async function replyAsChat(template: string) {
    const people = looseContacts(template, contacts).slice(0, 2)
    const loaded = { ...messagesByContact }
    if (ready) {
      for (const person of people) {
        if (loaded[person.id]?.length) continue
        loaded[person.id] = await ensureThread(person.id)
      }
    }
    const active = contacts.find((contact) => contact.id === activeContactId) ?? null
    const answer = answerQuestion(template, { contacts, messagesByContact: loaded, active, people })
    if (/n[aã]o lidas/i.test(template) && !/\bmarca/.test(template)) requestBrowse('unread')
    if (/\b(o que chegou hoje|chegou hoje|mensagens de hoje)\b/i.test(template)) requestBrowse('today')
    noteCommand(template, answer.text, answer.ids)
  }

  async function send() {
    const template = input.trim()
    const nextAction = detectAction(action, template, file)
    if (blasting) return
    const instant = instantAnswer(template)
    if (instant && !file && !selected.length && action === 'text') {
      setInput('')
      setError('')
      setOpenPicker(false)
      noteCommand(template, instant, [])
      return
    }
    const mention = messageMentions(template, contacts)
    if (mention.contacts.length || mention.unmatched.length) {
      if (!ready) {
        setError('Conecte o WhatsApp pelo QR primeiro')
        return
      }
      if (mention.unmatched.length) {
        setError(`Não achei @${mention.unmatched[0]} na sua lista`)
        return
      }
      if (!mention.text) {
        setError('Escreve a mensagem depois do nome, tipo: @kadu boa noite')
        return
      }
      const ids = [...selected.map((contact) => contact.id), ...mention.contacts.map((contact) => contact.id)]
      const unique = [...new Set(ids)]
      setInput('')
      setSelected([])
      setFile(null)
      setError('')
      setOpenPicker(false)
      await runCommand({
        type: file ? nextAction : 'text',
        contactIds: unique,
        text: mention.text,
        file: file ?? undefined,
        said: template,
      })
      return
    }
    // Sending a location was removed from the app; don't let it fall through and send the words as text.
    if (/\b(manda|envia|compartilha)\w*\b.*\blocaliza/.test(fold(template))) {
      setError('O app não envia localização. Mande pelo celular.')
      return
    }
    const parsed = parseCommand(template, contacts)
    const unrecognized = Boolean(template) && !parsed && !selected.length
    if (!ready && parsed?.assist !== 'help' && parsed?.assist !== 'lock-app' && !unrecognized) {
      setError('Conecte o WhatsApp pelo QR primeiro')
      return
    }
    if (unrecognized) {
      setInput('')
      setError('')
      setOpenPicker(false)
      if (action === 'text' && !file) {
        try {
          const decision = await askModel(template)
          if (decision) {
            await applyDecision(template, decision)
            return
          }
        } catch (caught) {
          setError(caught instanceof Error ? caught.message : 'O modelo não respondeu')
          return
        }
      }
      await replyAsChat(template)
      return
    }
    if (parsed?.assist || parsed?.phone) {
      if (parsed.assist === 'status-post' && !parsed.detail?.trim() && !file) {
        setError('Diga o texto, tipo: posta um status: bom dia')
        return
      }
      if (parsed.assist === 'lock-app' && !/^\d{4}$/.test(parsed.detail || '')) {
        setError('Diga o PIN de 4 dígitos, tipo: trava o app 1234')
        return
      }
      if (parsed.assist === 'group-picture' && !file) {
        setError('Anexe a foto e peça de novo: muda a foto do grupo')
        fileRef.current?.click()
        return
      }
      const attached = file
      setInput('')
      setSelected([])
      setFile(null)
      setError('')
      setOpenPicker(false)
      try {
        await runAssist(parsed, attached, template)
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Não deu pra fazer isso')
      }
      return
    }
    if (parsed) {
      const ids = parsed.contactIds.length
        ? parsed.contactIds
        : selected.length
          ? selected.map((contact) => contact.id)
          : activeContactId
            ? [activeContactId]
            : []
      if (!ids.length) {
        setError('Abra uma conversa ou marque um contato com @')
        return
      }
      remember(ids[0])
      if (['audio', 'photo', 'video', 'document', 'sticker', 'gif'].includes(parsed.type) && !file) {
        setError('Anexe o arquivo')
        fileRef.current?.click()
        return
      }
      if (parsed.type === 'edit' && !parsed.detail) {
        setError('Digite o novo texto, tipo: editar para bom dia')
        return
      }
      if (parsed.type === 'poll' && !(parsed.detail || '').includes('|')) {
        setError('Use: enquete Pergunta | opção 1 | opção 2')
        return
      }
      if (parsed.type === 'contact' && !parsed.detail) {
        setError('Diga qual contato, tipo: manda o contato do Pedro')
        return
      }
      if (parsed.type === 'forward' && !parsed.contactIds.length && !selected.length) {
        setError('Diga para quem encaminhar e selecione a mensagem')
        return
      }
      if (parsed.type === 'label' && !parsed.detail) {
        setError('Diga o nome da lista, tipo: lista Trabalho')
        return
      }
      if (parsed.type === 'reply' && !parsed.detail) {
        setError('Digite a resposta, tipo: responde que sim')
        return
      }
      if (parsed.type === 'text' && parsed.detail === '' && /manda|envia/i.test(template)) {
        setError('Digite o que enviar')
        return
      }
      setInput('')
      setSelected([])
      setFile(null)
      setError('')
      setOpenPicker(false)
      if (parsed.local) {
        requestUi(parsed.local, ids[0]!, parsed.detail)
        if (parsed.local === 'theme' || parsed.local === 'lock' || parsed.local === 'report') return
        noteCommand(template, LOCAL_NOTES[parsed.local], ids)
        return
      }
      await runCommand({
        type: parsed.type,
        contactIds: ids,
        text: parsed.detail ?? parsed.label,
        file: file ?? undefined,
        messageIds: pickedIds,
        said: template,
      })
      return
    }
    // A photo/file without a caption is normal: only stop when there is neither text nor file.
    if (!template && !file) return
    if (!selected.length) {
      if (file) {
        setError('Escolha para quem: toque em Contato ou marque com @')
        return
      }
      setInput('')
      setError('')
      setOpenPicker(false)
      await replyAsChat(template)
      return
    }
    if (nextAction === 'photo' && !file) {
      setError('Anexe uma foto')
      fileRef.current?.click()
      return
    }
    if (nextAction === 'audio' && !file) {
      setError('Anexe um áudio')
      fileRef.current?.click()
      return
    }
    if (nextAction === 'group' && !template.replace(/^(criar grupo|novo grupo|\/grupo)\s*/i, '').trim()) {
      setError('Digite o nome do grupo')
      return
    }
    if (nextAction === 'text' && !template) {
      setError('Digite a mensagem padrão')
      return
    }
    const ids = selected.map((contact) => contact.id)
    const payloadFile = file
    setInput('')
    setSelected([])
    setFile(null)
    setError('')
    setOpenPicker(false)
    await runCommand({
      type: nextAction,
      contactIds: ids,
      text: template,
      file: payloadFile ?? undefined,
      said: template,
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (pickerOpen && available.length) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((prev) => (prev + 1) % available.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((prev) => (prev - 1 + available.length) % available.length)
        return
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault()
        addContact(available[highlight]!)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpenPicker(false)
        return
      }
    }

    if (event.key === 'Backspace' && input === '' && selected.length) {
      removeContact(selected.at(-1)!.id)
      return
    }

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  }

  return (
    <aside
      className={`cmd ${draggingFile ? 'is-drag' : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        event.dataTransfer.dropEffect = 'copy'
        setDraggingFile(true)
      }}
      onDragLeave={() => setDraggingFile(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDraggingFile(false)
        void onPickFile(event.dataTransfer.files[0])
      }}
    >
      <header className="cmd-head">
        <div>
          <strong>Assistente</strong>
          <span>
            {ready
              ? 'Pergunta sobre as conversas ou pede uma ação'
              : 'Conecte o WhatsApp pelo QR pra ele responder com as conversas'}
          </span>
        </div>
      </header>

      <div className="cmd-log" ref={logRef}>
        {commandMessages.length === 0 ? (
          <div className="cmd-empty">
            <p>Pergunta em frase normal. O que manda mensagem só sai depois que você confirma.</p>
            <ul>
              <li>
                <code>o que você faz</code>
              </li>
              <li>
                <code>@kadu boa noite</code>
              </li>
              <li>
                <code>resume a conversa</code>, <code>mostra as não lidas</code>, <code>o que chegou hoje</code>
              </li>
              <li>
                <code>cadê o pix do Pedro</code>, <code>abre a conversa da Ana</code>
              </li>
              <li>
                <code>silencia esse grupo por uma semana</code>, <code>adiciona o Bruno</code>, <code>gera o link</code>
              </li>
              <li>
                <code>abre a Ana e responde que chego às 8</code>, <code>abre essa</code>, <code>o que ficou pendente</code>, <code>sugere uma resposta</code>
              </li>
            </ul>
          </div>
        ) : (
          commandMessages.map((message) => {
            const named = (message.contactIds ?? [])
              .map((id) => contacts.find((contact) => contact.id === id)?.name)
              .filter(Boolean)
            return (
              <article key={message.id} className={`cmd-msg ${message.role}`}>
                {message.role === 'user' ? (
                  <>
                    <div className="cmd-chips static">
                      {named.map((name) => (
                        <span key={name} className="chip">
                          {name}
                        </span>
                      ))}
                    </div>
                    <p>{message.text}</p>
                  </>
                ) : (
                  <>
                    <p>{message.text}</p>
                    <div className="cmd-jump">
                      {(message.contactIds ?? []).map((id) => {
                        const contact = contacts.find((item) => item.id === id)
                        if (!contact) return null
                        return (
                          <button key={id} type="button" onClick={() => setActiveContactId(id)}>
                            Ver {contact.name.split(' ')[0]}
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
                <time>{formatClock(message.at)}</time>
              </article>
            )
          })
        )}
      </div>

      <div className="cmd-box">
        <div className="cmd-actions">
          {ACTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`chip-btn ${action === item.id ? 'is-on' : ''}`}
              onClick={() => {
                setAction(item.id)
                if (item.id === 'text' || item.id === 'group') setFile(null)
                setError('')
              }}
            >
              {item.id === 'audio' ? <MicIcon size={14} /> : null}
              {item.id === 'photo' ? <AttachIcon size={14} /> : null}
              {item.id === 'group' ? <UsersIcon size={14} /> : null}
              {item.label}
            </button>
          ))}
        </div>

        {selected.length > 0 ? (
          <div className="cmd-chips">
            {selected.map((contact) => (
              <button
                key={contact.id}
                type="button"
                className="chip"
                onClick={() => removeContact(contact.id)}
              >
                <i style={{ background: contact.color }}>{contact.initials}</i>
                {contact.name}
                <CloseIcon />
              </button>
            ))}
          </div>
        ) : null}

        {file ? (
          <div className="cmd-chips">
            <button type="button" className="chip" onClick={() => setFile(null)}>
              {file.name}
              <CloseIcon />
            </button>
          </div>
        ) : null}

        {pickerOpen ? (
          <div className="mention-list" role="listbox">
            {available.length === 0 ? (
              <div className="mention-empty">Nenhum contato restante</div>
            ) : (
              available.map((contact, index) => (
                <button
                  key={contact.id}
                  type="button"
                  className={`mention-item ${index === highlight ? 'is-active' : ''}`}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => addContact(contact)}
                >
                  {photos[contact.id] ? (
                    <img className="avatar sm" src={photos[contact.id]} alt="" />
                  ) : (
                    <span className="avatar sm" style={{ background: contact.color }}>
                      {contact.initials}
                    </span>
                  )}
                  <span>
                    <strong>{contact.name}</strong>
                    <em>{contact.phone}</em>
                  </span>
                </button>
              ))
            )}
          </div>
        ) : null}

        <textarea
          ref={inputRef}
          value={input}
          rows={2}
          title="Enter envia · Shift+Enter quebra linha"
          placeholder={placeholderFor(action, selected.length > 0)}
          onChange={(event) => {
            setInput(event.target.value)
            setCaret(event.target.selectionStart)
            setError('')
          }}
          onClick={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyUp={(event) => setCaret(event.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
        />

        {error ? <p className="cmd-error">{error}</p> : null}

        <input
          ref={fileRef}
          className="file-input"
          type="file"
          accept="image/*,video/*,audio/*,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,.bmp"
          onChange={(event) => {
            void onPickFile(event.target.files?.[0])
            event.currentTarget.value = ''
          }}
        />

        <div className="cmd-tools">
          <button
            type="button"
            className="chip-btn"
            onClick={() => {
              setOpenPicker((prev) => !prev)
              inputRef.current?.focus()
            }}
          >
            <AtIcon />
            Contato
          </button>
          <button
            type="button"
            className="chip-btn"
            onClick={() => fileRef.current?.click()}
          >
            <AttachIcon size={16} />
            Arquivo
          </button>
          <button type="button" className="send-blast" onClick={() => void send()} disabled={blasting}>
            {blasting ? 'Enviando...' : action === 'group' ? 'Criar' : 'Enviar'}
            <SendIcon size={16} />
          </button>
        </div>
      </div>
    </aside>
  )
}
