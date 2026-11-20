import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { request, socket } from './api'
import { isFullMessageId, messageKey, sameMessageId } from './messageIds'
import type { LocalCommand } from './commands'
import { loadAppLocked, loadCommandLog, loadLists, loadLocked, loadPins, loadTheme, saveAppLocked, saveCommandLog, saveLists, saveLocked, savePins, savePin, saveTheme, savedPin, type LocalList, type ThemeId } from './local'
import type {
  BlastProgress,
  ChatMessage,
  CommandAction,
  CommandFile,
  ChatProfile,
  CommandMessage,
  ConnectionState,
  Contact,
  Poll,
} from './types'

type Store = {
  status: ConnectionState['status']
  qr: string | null
  me: ConnectionState['me']
  contacts: Contact[]
  photos: Record<string, string>
  messagesByContact: Record<string, ChatMessage[]>
  activeContactId: string | null
  commandMessages: CommandMessage[]
  blasting: boolean
  setActiveContactId: (id: string | null) => void
  requestUi: (kind: LocalCommand, contactId: string, detail?: string) => void
  noteCommand: (label: string, note: string, contactIds: string[]) => void
  uiRequest: { nonce: number; kind: LocalCommand; contactId: string; detail?: string } | null
  browseRequest: { nonce: number; mode: 'unread' | 'today' } | null
  requestBrowse: (mode: 'unread' | 'today') => void
  theme: ThemeId
  setTheme: (theme: ThemeId) => void
  lists: LocalList[]
  addToList: (name: string, contactIds: string[]) => void
  lockedIds: string[]
  lockChat: (contactId: string, pin: string) => boolean
  unlockChat: (contactId: string, pin: string) => boolean
  unlockPin: (pin: string) => boolean
  appLocked: boolean
  lockApp: (pin: string) => boolean
  unlockApp: (pin: string) => boolean
  pinnedByContact: Record<string, string[]>
  reportChat: (contactId: string) => Promise<string>
  openNumber: (phone: string) => Promise<Contact | null>
  fetchMedia: (contactId: string, messageId: string) => Promise<string>
  searchAll: (query: string) => Promise<{ contactId: string; contactName: string; messageId: string; text: string; at: number }[]>
  exportFull: (contactId: string) => Promise<ChatMessage[]>
  readMessageInfo: (messageId: string) => Promise<{ delivered: string[]; read: string[] }>
  votePoll: (contactId: string, messageId: string, optionIds: number[]) => Promise<void>
  loadStatuses: () => Promise<{ id: string; name: string; unread: number; text: string; at: number }[]>
  postStatus: (text: string, file?: CommandFile) => Promise<string>
  placeCall: (contactId: string, video: boolean) => Promise<{ message?: string; link?: string; error?: string }>
  groupAction: (input: {
    contactId: string
    action: 'add' | 'remove' | 'promote' | 'demote' | 'leave' | 'subject' | 'description' | 'picture' | 'invite'
    participantId?: string
    text?: string
    file?: CommandFile
  }) => Promise<string>
  sendTyping: (contactId: string, on: boolean) => void
  loadProfile: (id: string) => Promise<ChatProfile>
  sendInChat: (text: string, mentions?: string[]) => Promise<void>
  sendBlast: (contactIds: string[], template: string) => Promise<void>
  pickedIds: string[]
  setPickedIds: (ids: string[] | ((current: string[]) => string[])) => void
  replyTo: { id: string; preview: string } | null
  setReplyTo: (message: { id: string; preview: string } | null) => void
  sendFile: (
    file: CommandFile,
    kind: 'photo' | 'audio' | 'video' | 'document' | 'sticker' | 'gif',
    caption?: string,
  ) => Promise<void>
  pendingCommand: { label: string; input: {
    type: CommandAction
    contactIds: string[]
    text?: string
    file?: CommandFile
    messageIds?: string[]
    said?: string
    quiet?: boolean
  }; task?: () => Promise<void> } | null
  askConfirm: (label: string, task: () => Promise<void>) => void
  confirmPending: () => void
  cancelPending: () => void
  loadEarlier: (contactId: string, before: number) => Promise<number>
  ensureThread: (contactId: string) => Promise<ChatMessage[]>
  runCommand: (input: {
    type: CommandAction
    contactIds: string[]
    text?: string
    file?: CommandFile
    messageIds?: string[]
    said?: string
    quiet?: boolean
  }) => Promise<void>
  logout: () => void
}

const StoreContext = createContext<Store | null>(null)

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

function upsertMessage(
  prev: Record<string, ChatMessage[]>,
  message: ChatMessage,
): Record<string, ChatMessage[]> {
  const list = prev[message.contactId] ?? []
  const existing = list.find((item) => sameSend(item, message))
  if (existing) {
    const changed =
      preferId(existing.id, message.id) !== existing.id ||
      (message.media && message.media !== existing.media) ||
      (message.authorName && message.authorName !== existing.authorName) ||
      (message.duration && message.duration !== existing.duration) ||
      (message.text && message.text !== existing.text) ||
      (message.quote && message.quote.id !== existing.quote?.id) ||
      (message.starred !== undefined && message.starred !== existing.starred) ||
      (message.pinned !== undefined && message.pinned !== existing.pinned) ||
      (message.gif !== undefined && message.gif !== existing.gif) ||
      (message.poll && JSON.stringify(message.poll) !== JSON.stringify(existing.poll)) ||
      (message.reactions && JSON.stringify(message.reactions) !== JSON.stringify(existing.reactions))
    if (changed) {
      return {
        ...prev,
        [message.contactId]: list.map((item) =>
          item === existing
            ? {
                ...existing,
                ...message,
                id: preferId(existing.id, message.id),
                media: message.media || existing.media,
                quote: message.quote || existing.quote,
                pinned: message.pinned ?? existing.pinned,
                gif: message.gif ?? existing.gif,
                poll: message.poll ?? existing.poll,
                reactions: message.reactions ?? existing.reactions,
              }
            : item,
        ),
      }
    }
    return prev
  }
  return {
    ...prev,
    [message.contactId]: [...list, message].sort((a, b) => a.at - b.at),
  }
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ConnectionState['status']>('idle')
  const [qr, setQr] = useState<string | null>(null)
  const [me, setMe] = useState<ConnectionState['me']>(null)
  const [contacts, setContacts] = useState<Contact[]>([])
  const [photos, setPhotos] = useState<Record<string, string>>({})
  const [messagesByContact, setMessagesByContact] = useState<Record<string, ChatMessage[]>>({})
  const [activeContactId, setActiveContactIdState] = useState<string | null>(null)
  const [commandMessages, setCommandMessages] = useState<CommandMessage[]>(() => loadCommandLog())
  const [blasting, setBlasting] = useState(false)
  const [uiRequest, setUiRequest] = useState<Store['uiRequest']>(null)
  const [browseRequest, setBrowseRequest] = useState<Store['browseRequest']>(null)
  const [pickedIds, setPickedIds] = useState<string[]>([])
  const [replyTo, setReplyTo] = useState<{ id: string; preview: string } | null>(null)
  const [pendingCommand, setPendingCommand] = useState<Store['pendingCommand']>(null)
  const [theme, setThemeState] = useState<ThemeId>(() => loadTheme())
  const [lists, setLists] = useState<LocalList[]>(() => loadLists())
  const [lockedIds, setLockedIds] = useState<string[]>(() => loadLocked())
  const [appLocked, setAppLocked] = useState(() => loadAppLocked())
  const [pinnedByContact, setPinnedByContact] = useState<Record<string, string[]>>(() => loadPins())
  const messagesRef = useRef(messagesByContact)
  messagesRef.current = messagesByContact
  const contactsRef = useRef<Contact[]>([])
  contactsRef.current = contacts

  useEffect(() => {
    function applyState(state: ConnectionState) {
      setStatus(state.status)
      setQr(state.qr)
      setMe(state.me)
      if (state.status === 'idle' || state.status === 'qr') setPhotos({})
    }

    function onPhotos(rows: { id?: string; photo?: string }[]) {
      if (!rows?.length) return
      setPhotos((prev) => {
        const next = { ...prev }
        for (const row of rows) {
          if (row?.id && row.photo) next[row.id] = row.photo
        }
        return next
      })
    }

    function onSnapshot(payload: {
      status: ConnectionState['status']
      qr: string | null
      me: ConnectionState['me']
      chats: Contact[]
      messagesByContact: Record<string, ChatMessage[]>
    }) {
      applyState(payload)
      setContacts(payload.chats)
      const cleaned: Record<string, ChatMessage[]> = {}
      for (const [id, list] of Object.entries(payload.messagesByContact)) cleaned[id] = collapseMessages(list)
      setMessagesByContact(cleaned)
      setActiveContactIdState((current) => current ?? payload.chats[0]?.id ?? null)
    }

    socket.on('snapshot', onSnapshot)
    socket.on('state', applyState)
    socket.on('photos', onPhotos)
    socket.on('chats', (next: Contact[]) => {
      setContacts(next)
      setActiveContactIdState((current) => {
        if (current && next.some((contact) => contact.id === current)) return current
        return next[0]?.id ?? null
      })
    })
    socket.on('message', (message: ChatMessage) => {
      setMessagesByContact((prev) => upsertMessage(prev, message))
      if (!message.fromMe && Date.now() - message.at < 20_000) {
        const name = contactsRef.current.find((contact) => contact.id === message.contactId)?.name || 'WhatsApp'
        if (typeof Notification !== 'undefined') {
          if (Notification.permission === 'default') void Notification.requestPermission()
          if (Notification.permission === 'granted' && document.hidden) {
            new Notification(name, { body: message.text || 'Nova mensagem' })
          }
        }
        if (document.hidden) {
          try {
            const audio = new AudioContext()
            const osc = audio.createOscillator()
            const gain = audio.createGain()
            osc.frequency.value = 880
            gain.gain.value = 0.05
            osc.connect(gain)
            gain.connect(audio.destination)
            osc.start()
            osc.stop(audio.currentTime + 0.12)
          } catch {
            /* ignore */
          }
        }
      }
    })
    socket.on('thread', ({ messages }: { contactId: string; messages: ChatMessage[] }) => {
      setMessagesByContact((prev) => {
        const next = { ...prev }
        for (const message of messages) {
          const merged = upsertMessage(next, message)
          Object.assign(next, merged)
        }
        return next
      })
    })
    socket.on('blast:progress', (progress: BlastProgress) => {
      setCommandMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: progress.ok
            ? `(${progress.index}/${progress.total}) Enviado para ${progress.name}`
            : `(${progress.index}/${progress.total}) Falhou em ${progress.name}: ${progress.error}`,
          contactIds: [progress.contactId],
          at: Date.now(),
        },
      ])
    })

    return () => {
      socket.off('snapshot', onSnapshot)
      socket.off('state', applyState)
      socket.off('photos', onPhotos)
      socket.off('chats')
      socket.off('message')
      socket.off('thread')
      socket.off('blast:progress')
    }
  }, [])

  useEffect(() => {
    saveCommandLog(commandMessages)
  }, [commandMessages])

  useEffect(() => {
    savePins(pinnedByContact)
  }, [pinnedByContact])

  useEffect(() => {
    saveLists(lists)
  }, [lists])

  useEffect(() => {
    saveLocked(lockedIds)
  }, [lockedIds])

  const sendInChat = useCallback(async (text: string, mentions: string[] = []) => {
    const trimmed = text.trim()
    if (!trimmed || !activeContactId) return
    const quotedMessageId = replyTo?.id
    const quoteText = replyTo?.preview
    const res = await request('send', { contactId: activeContactId, text: trimmed, quotedMessageId, quoteText, mentions })
    if (!res.ok) throw new Error(res.error || 'Falha ao enviar')
    setReplyTo(null)
  }, [activeContactId, replyTo])

  const sendFile = useCallback(async (
    file: CommandFile,
    kind: 'photo' | 'audio' | 'video' | 'document' | 'sticker' | 'gif',
    caption = '',
  ) => {
    if (!activeContactId) return
    const res = await request('send-media', { contactId: activeContactId, file, kind, caption }, 180_000)
    if (!res.ok) throw new Error(res.error || 'Falha ao enviar arquivo')
  }, [activeContactId])

  const loadEarlier = useCallback(async (contactId: string, before: number) => {
    const res = await request<{ messages?: unknown[] }>('load-earlier', { contactId, before })
    return res.messages?.length ?? 0
  }, [])

  const runCommand = useCallback(async (input: {
    type: CommandAction
    contactIds: string[]
    text?: string
    file?: CommandFile
    messageIds?: string[]
    said?: string
    quiet?: boolean
    confirmed?: boolean
  }) => {
    const many = input.contactIds.length > 1
    // Never send an empty message (no text and no file): it used to go out as a blank bubble.
    if ((input.type === 'text' || input.type === 'reply') && !input.text?.trim() && !input.file) {
      setCommandMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: 'Não mandei nada: a mensagem estava vazia. Para mandar foto, anexe o arquivo (📎) e escreva, tipo: manda foto pro André.',
          contactIds: input.contactIds,
          at: Date.now(),
        },
      ])
      return
    }
    const draft = (input.type === 'text' || input.type === 'reply') && Boolean(input.text?.trim())
    const media = ['photo', 'audio', 'video', 'document', 'sticker', 'gif'].includes(input.type)
    const dangerous =
      !input.confirmed &&
      (input.type === 'delete' ||
        input.type === 'clear' ||
        input.type === 'block' ||
        input.type === 'forward' ||
        draft ||
        // Files are confirmed too (to one person or many), naming who gets them.
        (media && Boolean(input.file)) ||
        (many && ['contact', 'poll'].includes(input.type)))
    if (dangerous) {
      const preview = (input.text || '').trim().slice(0, 180)
      // Always say who is affected, so a message can't go to the wrong chat unnoticed.
      const nameOf = (id: string) => {
        const found = contactsRef.current.find((contact) => contact.id === id)
        return found?.name || found?.phone || id.split('@')[0] || 'contato'
      }
      const shown = input.contactIds.slice(0, 3).map(nameOf).join(', ')
      const who = many
        ? `${input.contactIds.length} contatos (${shown}${input.contactIds.length > 3 ? '…' : ''})`
        : input.contactIds[0]
          ? nameOf(input.contactIds[0])
          : 'a conversa aberta'
      const label =
        input.type === 'reply'
          ? `Responder ${who}? “${preview}”`
          : input.type === 'text' && preview
            ? `Enviar para ${who}? “${preview}”`
          : input.type === 'block'
          ? `Bloquear ${who}?`
          : input.type === 'clear'
            ? `Limpar a conversa com ${who}?`
            : input.type === 'forward'
              ? `Encaminhar a mensagem selecionada para ${who}?`
              : input.type === 'delete'
                ? input.text === 'me'
                  ? `Apagar esta mensagem só para você (conversa com ${who})?`
                  : `Apagar esta mensagem para todos (conversa com ${who})?`
                : media
                  ? `Enviar ${
                      input.type === 'photo' ? 'a foto' : input.type === 'audio' ? 'o áudio' : input.type === 'video' ? 'o vídeo' : input.type === 'sticker' ? 'a figurinha' : input.type === 'gif' ? 'o GIF' : 'o arquivo'
                    }${input.file?.name ? ` “${input.file.name}”` : ''} para ${who}?${preview ? ` Legenda: “${preview}”` : ''}`
                  : `Enviar para ${who}?`
      setPendingCommand({
        label,
        input: {
          type: input.type,
          contactIds: input.contactIds,
          text: input.text,
          file: input.file,
          messageIds: input.messageIds,
          said: input.said,
          quiet: input.quiet,
        },
      })
      return
    }
    const label =
      input.type === 'group'
        ? `Criar grupo: ${input.text?.trim() || ''}`
        : input.type === 'photo'
          ? `Foto${input.file?.name ? `: ${input.file.name}` : ''}${input.text?.trim() ? ` — ${input.text.trim()}` : ''}`
          : input.type === 'audio'
            ? `Áudio${input.file?.name ? `: ${input.file.name}` : ''}`
            : input.text?.trim() || ''
    if (input.type === 'label' && input.text?.trim()) {
      const name = input.text.trim()
      setLists((current) => {
        const found = current.find((list) => list.name.toLowerCase() === name.toLowerCase())
        if (found) {
          return current.map((list) =>
            list.id === found.id
              ? { ...list, contactIds: [...new Set([...list.contactIds, ...input.contactIds])] }
              : list,
          )
        }
        return [...current, { id: crypto.randomUUID(), name, contactIds: input.contactIds }]
      })
    }
    setBlasting(true)
    if (!input.quiet) {
      setCommandMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'user',
          text: input.said?.trim() || label,
          contactIds: input.contactIds,
          at: Date.now(),
        },
      ])
    }
    if (input.contactIds[0] && input.type !== 'forward') setActiveContactIdState(input.contactIds[0])
    try {
      // Bulk sends wait 2s between contacts on the server, so allow time per contact.
      const result = await request<{
        sent?: number
        failed?: number
        title?: string
        groupId?: string
        message?: string
        removedIds?: string[]
        cleared?: boolean
      }>(
        'command',
        {
          type: input.type,
          contactIds: input.contactIds,
          text: input.text,
          file: input.file,
          messageIds: input.messageIds,
        },
        120_000 + input.contactIds.length * 20_000,
      )
      // Reflect archive / mute / favorite right away (the chat moves to "Arquivadas", gets the mute icon…).
      const chatPatch: Partial<Contact> | null = !result.ok
        ? null
        : input.type === 'archive'
          ? { archived: true }
          : input.type === 'unarchive'
            ? { archived: false }
            : input.type === 'mute'
              ? { muted: true }
              : input.type === 'unmute'
                ? { muted: false }
                : input.type === 'pin'
                  ? { pinned: true }
                  : input.type === 'unpin'
                    ? { pinned: false }
                    : null
      if (chatPatch) {
        setContacts((prev) => prev.map((contact) => (input.contactIds.includes(contact.id) ? { ...contact, ...chatPatch } : contact)))
      }
      if (result.cleared && input.contactIds[0]) {
        setMessagesByContact((prev) => ({ ...prev, [input.contactIds[0]!]: [] }))
      }
      if (result.removedIds?.length && input.contactIds[0]) {
        const contactId = input.contactIds[0]
        setMessagesByContact((prev) => ({
          ...prev,
          [contactId]: (prev[contactId] ?? []).filter((item) => !result.removedIds?.includes(item.id)),
        }))
      }
      const okText = result.message
        ? result.ok
          ? result.message
          : result.error || result.message
        : input.type === 'group'
          ? result.ok
            ? `Grupo criado: ${result.title || input.text}. ${result.sent ?? 0} pessoa(s) adicionada(s).`
            : result.error || 'Falha ao criar o grupo'
          : result.ok
            ? `Pronto: ${result.sent ?? 0} enviada(s)${result.failed ? `, ${result.failed} falha(s)` : ''}.`
            : result.error || 'Falha na ação'
      const contactId = input.contactIds[0]
      if (result.ok && contactId && (input.type === 'pinmsg' || input.type === 'unpinmsg')) {
        let ids = input.messageIds?.filter(Boolean) ?? []
        if (!ids.length) {
          const last = messagesRef.current[contactId]?.at(-1)
          if (last) ids = [last.id]
        }
        if (ids.length) {
          setPinnedByContact((prev) => {
            const next = new Set(prev[contactId] ?? [])
            for (const id of ids) {
              if (input.type === 'pinmsg') next.add(id)
              else next.delete(id)
            }
            return { ...prev, [contactId]: [...next] }
          })
          setMessagesByContact((prev) => ({
            ...prev,
            [contactId]: (prev[contactId] ?? []).map((item) =>
              ids.includes(item.id) ? { ...item, pinned: input.type === 'pinmsg' } : item,
            ),
          }))
        }
      }
      setCommandMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'system',
          text: okText,
          contactIds: result.groupId ? [...input.contactIds, result.groupId] : input.contactIds,
          at: Date.now(),
        },
      ])
    } finally {
      setBlasting(false)
    }
  }, [])

  const sendBlast = useCallback(
    async (contactIds: string[], template: string) => {
      await runCommand({ type: 'text', contactIds, text: template })
    },
    [runCommand],
  )

  const loadProfile = useCallback(async (id: string) => {
    const res = await request<Partial<ChatProfile>>('profile', { contactId: id })
    return {
      description: res.description || '',
      phone: res.phone || '',
      muted: Boolean(res.muted),
      disappearing: res.disappearing || 'Desligadas',
      media: res.media || 0,
      links: res.links || 0,
      docs: res.docs || 0,
      starred: res.starred || 0,
      participants: res.participants ?? [],
      commonGroups: res.commonGroups ?? [],
      mediaItems: res.mediaItems ?? [],
      linkItems: res.linkItems ?? [],
      docItems: res.docItems ?? [],
      starredItems: res.starredItems ?? [],
    } satisfies ChatProfile
  }, [])

  const mergeThread = useCallback((messages: ChatMessage[]) => {
    setMessagesByContact((prev) => {
      const next = { ...prev }
      for (const message of messages) Object.assign(next, upsertMessage(next, message))
      return next
    })
  }, [])

  const setActiveContactId = useCallback((id: string | null) => {
    setActiveContactIdState(id)
    if (!id) return
    socket.emit('open-chat', { contactId: id }, (res: { ok?: boolean; messages?: ChatMessage[] }) => {
      if (!res?.messages) return
      mergeThread(res.messages)
    })
  }, [mergeThread])

  const ensureThread = useCallback(async (contactId: string) => {
    const res = await request<{ messages?: ChatMessage[] }>('peek-thread', { contactId })
    const messages = res.messages ?? []
    mergeThread(messages)
    return messages
  }, [mergeThread])

  const requestUi = useCallback((kind: LocalCommand, contactId: string, detail?: string) => {
    setUiRequest({ nonce: Date.now(), kind, contactId, detail })
  }, [])

  const requestBrowse = useCallback((mode: 'unread' | 'today') => {
    setBrowseRequest({ nonce: Date.now(), mode })
  }, [])

  const setTheme = useCallback((next: ThemeId) => {
    setThemeState(next)
    saveTheme(next)
  }, [])

  const addToList = useCallback((name: string, contactIds: string[]) => {
    const label = name.trim()
    if (!label) return
    setLists((current) => {
      const found = current.find((list) => list.name.toLowerCase() === label.toLowerCase())
      if (found) {
        return current.map((list) =>
          list.id === found.id ? { ...list, contactIds: [...new Set([...list.contactIds, ...contactIds])] } : list,
        )
      }
      return [...current, { id: crypto.randomUUID(), name: label, contactIds }]
    })
  }, [])

  const lockChat = useCallback((contactId: string, pin: string) => {
    if (!/^\d{4}$/.test(pin)) return false
    const current = localStorage.getItem('zap-pin') || ''
    if (current && current !== pin) return false
    if (!current) localStorage.setItem('zap-pin', pin)
    setLockedIds((ids) => (ids.includes(contactId) ? ids : [...ids, contactId]))
    return true
  }, [])

  const unlockPin = useCallback((pin: string) => localStorage.getItem('zap-pin') === pin, [])

  const unlockChat = useCallback((contactId: string, pin: string) => {
    if (localStorage.getItem('zap-pin') !== pin) return false
    setLockedIds((ids) => ids.filter((id) => id !== contactId))
    return true
  }, [])

  const lockApp = useCallback((pin: string) => {
    if (!/^\d{4}$/.test(pin)) return false
    const current = savedPin()
    if (current && current !== pin) return false
    if (!current) savePin(pin)
    setAppLocked(true)
    saveAppLocked(true)
    return true
  }, [])

  const unlockApp = useCallback((pin: string) => {
    if (savedPin() !== pin) return false
    setAppLocked(false)
    saveAppLocked(false)
    return true
  }, [])

  const reportChat = useCallback(async (contactId: string) => {
    const res = await request<{ ok?: boolean; message?: string; error?: string }>('report', { contactId })
    if (!res.ok) throw new Error(res.error || 'Falha ao denunciar')
    return res.message || 'Denúncia enviada.'
  }, [])

  const openNumber = useCallback(async (phone: string) => {
    const res = await request<{ ok?: boolean; contact?: Contact; error?: string }>('open-number', { phone })
    if (!res.ok || !res.contact) throw new Error(res.error || 'Falha ao abrir o número')
    setActiveContactIdState(res.contact.id)
    return res.contact
  }, [])

  const fetchMedia = useCallback(async (contactId: string, messageId: string) => {
    const res = await request<{ ok?: boolean; media?: string; error?: string }>('fetch-media', { contactId, messageId })
    if (!res.ok || !res.media) throw new Error(res.error || 'Falha ao baixar')
    setMessagesByContact((prev) => {
      const list = prev[contactId] ?? []
      return {
        ...prev,
        [contactId]: list.map((item) => (item.id === messageId ? { ...item, media: res.media } : item)),
      }
    })
    return res.media
  }, [])

  const searchAll = useCallback(async (query: string) => {
    const res = await request<{ hits?: { contactId: string; contactName: string; messageId: string; text: string; at: number }[] }>('search-all', { query })
    return res.hits ?? []
  }, [])

  const exportFull = useCallback(async (contactId: string) => {
    const res = await request<{ ok?: boolean; messages?: ChatMessage[]; error?: string }>('export-full', { contactId }, 600000)
    if (!res.ok) throw new Error(res.error || 'Falha ao exportar')
    return res.messages ?? []
  }, [])

  const votePoll = useCallback(async (contactId: string, messageId: string, optionIds: number[]) => {
    const res = await request<{ poll?: Poll }>('poll-vote', { contactId, messageId, optionIds })
    if (!res.ok) throw new Error(res.error || 'Não deu para votar')
    const poll = res.poll
    if (!poll) return
    setMessagesByContact((prev) => ({
      ...prev,
      [contactId]: (prev[contactId] ?? []).map((item) => (sameMessageId(item.id, messageId) ? { ...item, poll } : item)),
    }))
  }, [])

  const readMessageInfo = useCallback(async (messageId: string) => {
    const res = await request<{ ok?: boolean; delivered?: string[]; read?: string[]; error?: string }>('message-info', { messageId })
    if (!res.ok) throw new Error(res.error || 'Falha ao abrir as informações')
    return { delivered: res.delivered ?? [], read: res.read ?? [] }
  }, [])

  const loadStatuses = useCallback(async () => {
    const res = await request<{ items?: { id: string; name: string; unread: number; text: string; at: number }[] }>('statuses')
    return res.items ?? []
  }, [])

  const postStatus = useCallback(async (text: string, file?: CommandFile) => {
    const res = await request<{ ok?: boolean; message?: string; error?: string }>('post-status', { text, file }, 180000)
    if (!res.ok) throw new Error(res.error || 'Falha ao publicar')
    return res.message || 'Status publicado.'
  }, [])

  const placeCall = useCallback(async (contactId: string, video: boolean) => {
    return request<{ message?: string; link?: string; error?: string; ok?: boolean }>('call', { contactId, video })
  }, [])

  const groupAction = useCallback(async (input: Parameters<Store['groupAction']>[0]) => {
    const res = await request<{ ok?: boolean; message?: string; error?: string }>('group-action', input)
    if (!res.ok) throw new Error(res.error || 'Falha no grupo')
    return res.message || 'Pronto.'
  }, [])

  const sendTyping = useCallback((contactId: string, on: boolean) => {
    socket.emit('typing', { contactId, on })
  }, [])

  const noteCommand = useCallback((label: string, note: string, contactIds: string[]) => {
    const at = Date.now()
    setCommandMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: 'user', text: label, contactIds, at },
      { id: crypto.randomUUID(), role: 'system', text: note, contactIds, at: at + 1 },
    ])
  }, [])

  const pendingRef = useRef(pendingCommand)
  pendingRef.current = pendingCommand
  const askConfirm = useCallback((label: string, task: () => Promise<void>) => {
    setPendingCommand({
      label,
      input: { type: 'text', contactIds: [] },
      task,
    })
  }, [])
  const confirmPending = useCallback(() => {
    const pending = pendingRef.current
    setPendingCommand(null)
    if (!pending) return
    if (pending.task) {
      void pending.task()
      return
    }
    void runCommand({ ...pending.input, confirmed: true })
  }, [runCommand])
  const cancelPending = useCallback(() => setPendingCommand(null), [])

  const logout = useCallback(() => {
    socket.emit('logout')
    setContacts([])
    setPhotos({})
    setMessagesByContact({})
    setActiveContactIdState(null)
    setCommandMessages([])
  }, [])

  const value = useMemo<Store>(
    () => ({
      status,
      qr,
      me,
      contacts,
      photos,
      messagesByContact,
      activeContactId,
      commandMessages,
      blasting,
      pickedIds,
      setPickedIds,
      replyTo,
      setReplyTo,
      sendFile,
      loadEarlier,
      ensureThread,
      pendingCommand,
      askConfirm,
      confirmPending,
      cancelPending,
      setActiveContactId,
      requestUi,
      noteCommand,
      uiRequest,
      browseRequest,
      requestBrowse,
      theme,
      setTheme,
      lists,
      addToList,
      lockedIds,
      lockChat,
      unlockChat,
      unlockPin,
      appLocked,
      lockApp,
      unlockApp,
      pinnedByContact,
      reportChat,
      openNumber,
      fetchMedia,
      searchAll,
      exportFull,
      readMessageInfo,
      votePoll,
      loadStatuses,
      postStatus,
      placeCall,
      groupAction,
      sendTyping,
      loadProfile,
      sendInChat,
      sendBlast,
      runCommand,
      logout,
    }),
    [
      status,
      qr,
      me,
      contacts,
      photos,
      messagesByContact,
      activeContactId,
      commandMessages,
      blasting,
      pickedIds,
      setPickedIds,
      replyTo,
      setReplyTo,
      sendFile,
      loadEarlier,
      ensureThread,
      pendingCommand,
      askConfirm,
      confirmPending,
      cancelPending,
      setActiveContactId,
      requestUi,
      noteCommand,
      uiRequest,
      browseRequest,
      requestBrowse,
      theme,
      setTheme,
      lists,
      addToList,
      lockedIds,
      lockChat,
      unlockChat,
      unlockPin,
      appLocked,
      lockApp,
      unlockApp,
      pinnedByContact,
      reportChat,
      openNumber,
      fetchMedia,
      searchAll,
      exportFull,
      readMessageInfo,
      votePoll,
      loadStatuses,
      postStatus,
      placeCall,
      groupAction,
      sendTyping,
      loadProfile,
      sendInChat,
      sendBlast,
      runCommand,
      logout,
    ],
  )

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore precisa estar dentro de StoreProvider')
  return store
}
