import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { formatClock, formatTime } from '../format'
import {
  AttachIcon,
  CloseIcon,
  DotsIcon,
  MessageIcon,
  MicIcon,
  SearchIcon,
  SearchSmallIcon,
  SendIcon,
  SmileIcon,
  StatusIcon,
} from '../icons'
import { startOfToday } from '../assist'
import { LOCAL_NOTES } from '../commands'
import { chatExportHtml, downloadBlob } from '../exportChat'
import { loadDrafts, saveDrafts, savedPin } from '../local'
import { useStore } from '../store'
import { PollBubble } from './PollBubble'
import type { ChatMessage, ChatProfile, CommandAction, CommandFile, Contact, LibraryItem, Participant } from '../types'

const EMOJIS = ['😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😅', '😭', '😡', '👍', '👎', '🙏', '👏', '🔥', '❤️', '💚', '✨', '🎉', '✅', '❌', '💯', '🤝', '😴', '🙄', '🥳', '😢', '🤗', '👀', '💬', '📷', '🎵', '⭐']

const LINK_PATTERN = /((?:https?:\/\/|www\.)[^\s]+)/gi

function Avatar({
  contact,
  size = 40,
}: {
  contact: Pick<Contact, 'initials' | 'color'> & { photo?: string }
  size?: number
}) {
  if (contact.photo) {
    return <img className="avatar" src={contact.photo} alt="" style={{ width: size, height: size }} />
  }
  return (
    <div
      className="avatar"
      style={{ width: size, height: size, background: contact.color, fontSize: size * 0.34 }}
    >
      {contact.initials}
    </div>
  )
}

const emptyProfile: ChatProfile = {
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
}

const MEDIA_LABELS = new Set(['Foto', 'Áudio', 'Vídeo', 'Figurinha', 'Documento'])

function Ticks({ status }: { status?: ChatMessage['status'] }) {
  if (status === 'sent') return <span className="ticks">✓</span>
  return <span className={`ticks ${status === 'read' ? 'is-read' : ''}`}>✓✓</span>
}

function clock(seconds: number) {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}

function VoiceNote({ src, duration }: { src: string; duration?: number }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [decoded, setDecoded] = useState(0)
  const total = duration && duration > 0 ? duration : decoded

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    const onTime = () => setCurrent(audio.currentTime || 0)
    const onMeta = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDecoded(Math.round(audio.duration))
    }
    const onEnd = () => {
      setPlaying(false)
      setCurrent(0)
    }
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('durationchange', onMeta)
    audio.addEventListener('ended', onEnd)
    return () => {
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('durationchange', onMeta)
      audio.removeEventListener('ended', onEnd)
    }
  }, [src])

  async function toggle() {
    const audio = audioRef.current
    if (!audio) return
    if (playing) {
      audio.pause()
      setPlaying(false)
      return
    }
    await audio.play()
    setPlaying(true)
  }

  return (
    <div className="voice">
      <button type="button" className="voice-play" onClick={() => void toggle()} aria-label={playing ? 'Pausar' : 'Ouvir'}>
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="voice-track" aria-hidden="true">
        <i style={{ width: `${total ? Math.min(100, (current / total) * 100) : 0}%` }} />
      </span>
      <span className="voice-time">
        {clock(current)}/{clock(total)}
      </span>
      <audio ref={audioRef} src={src} preload="metadata" />
    </div>
  )
}

function fileFromMedia(message: ChatMessage): CommandFile | null {
  const media = message.media || ''
  const match = media.match(/^data:([^;,]+);base64,(.+)$/)
  if (!match?.[1] || !match[2]) return null
  return { name: message.filename || 'arquivo', mimetype: match[1], data: match[2] }
}

function isRawPreview(text: string) {
  return text.length > 64 && (/^\/9j\//.test(text) || /^iVBOR/.test(text) || /^UklGR/.test(text) || /^R0lGOD/.test(text))
}

function captionOf(text: string) {
  const value = text.trim()
  if (!value || MEDIA_LABELS.has(value) || isRawPreview(value)) return ''
  return text
}

function previewOf(text: string, kind?: string) {
  const caption = captionOf(text)
  if (caption) return caption
  if (kind === 'image') return 'Foto'
  if (kind === 'audio') return 'Áudio'
  if (kind === 'video') return 'Vídeo'
  if (kind === 'sticker') return 'Figurinha'
  return text
}

function statusLabel(status: string) {
  if (status === 'ready') return 'conectado'
  if (status === 'qr') return 'escaneie o QR'
  if (status === 'connecting') return 'conectando...'
  if (status === 'offline') return 'offline'
  return 'aguardando'
}

function colorFor(id: string) {
  const colors = ['#00a884', '#53bdeb', '#df9d3a', '#c486ea', '#06cf9c', '#ef5d6a', '#6aa3f9']
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return colors[hash % colors.length]!
}

function initialsOf(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
}

function MessageText({ text }: { text: string }) {
  const nodes: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(LINK_PATTERN)) {
    const index = match.index ?? 0
    if (index > last) nodes.push(text.slice(last, index))
    let raw = match[1] ?? ''
    const trail = raw.match(/[),.!?;:]+$/)
    let suffix = ''
    if (trail) {
      suffix = trail[0]
      raw = raw.slice(0, -suffix.length)
    }
    const href = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
    nodes.push(
      <a key={`${index}-${raw}`} href={href} target="_blank" rel="noreferrer noopener">
        {raw}
      </a>,
    )
    if (suffix) nodes.push(suffix)
    last = index + match[0].length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return <>{nodes}</>
}

export function WhatsAppPanel() {
  const {
    contacts,
    messagesByContact,
    activeContactId,
    setActiveContactId,
    loadProfile,
    sendInChat,
    sendFile,
    loadEarlier,
    pickedIds,
    setPickedIds,
    replyTo,
    setReplyTo,
    runCommand,
    requestUi,
    noteCommand,
    uiRequest,
    browseRequest,
    status,
    qr,
    me,
    photos,
    logout,
    theme,
    setTheme,
    lists,
    lockedIds,
    lockChat,
    unlockChat,
    unlockPin,
    lockApp,
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
  } = useStore()
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [infoOpen, setInfoOpen] = useState(false)
  const [infoQuery, setInfoQuery] = useState('')
  const [profile, setProfile] = useState<ChatProfile>(emptyProfile)
  const [infoLoading, setInfoLoading] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [threadQuery, setThreadQuery] = useState('')
  const [pinned, setPinned] = useState<Contact | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [recording, setRecording] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [mentions, setMentions] = useState<string[]>([])
  const [listFilter, setListFilter] = useState('all')
  const [showArchived, setShowArchived] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [newPhone, setNewPhone] = useState('')
  const [statusOpen, setStatusOpen] = useState(false)
  const [statuses, setStatuses] = useState<{ id: string; name: string; unread: number; text: string; at: number }[]>([])
  const [statusText, setStatusText] = useState('')
  const [statusNote, setStatusNote] = useState('')
  const [attachOpen, setAttachOpen] = useState(false)
  const [callNote, setCallNote] = useState<{ message: string; link?: string } | null>(null)
  const [library, setLibrary] = useState<'media' | 'links' | 'docs' | 'starred' | null>(null)
  const [menuMessage, setMenuMessage] = useState<ChatMessage | null>(null)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [infoNote, setInfoNote] = useState('')
  const [jumpId, setJumpId] = useState<string | null>(null)
  const [matchAt, setMatchAt] = useState(0)
  const [hits, setHits] = useState<{ contactId: string; contactName: string; messageId: string; text: string; at: number }[]>([])
  const [unlocked, setUnlocked] = useState<string[]>([])
  const [pinDraft, setPinDraft] = useState('')
  const [pinError, setPinError] = useState('')
  const [lockSetup, setLockSetup] = useState(false)
  const [appPin, setAppPin] = useState('')
  const [dragging, setDragging] = useState(false)
  const [attachError, setAttachError] = useState('')
  const dragDepth = useRef(0)
  const [mediaGrid, setMediaGrid] = useState<'sticker' | 'gif' | null>(null)
  const [statusFile, setStatusFile] = useState<CommandFile | null>(null)
  const [hitAt, setHitAt] = useState(0)
  const listSearchRef = useRef<HTMLInputElement>(null)
  const threadSearchRef = useRef<HTMLInputElement>(null)
  const [groupNote, setGroupNote] = useState('')
  const drafts = useRef(loadDrafts())
  const draftRef = useRef('')
  const scroller = useRef<HTMLDivElement>(null)
  const attachRef = useRef<HTMLInputElement>(null)
  const recorder = useRef<MediaRecorder | null>(null)
  const recordChunks = useRef<Blob[]>([])
  const loadingOlder = useRef(false)
  const pendingOlder = useRef(false)
  const olderHeight = useRef(0)
  const noMore = useRef(false)
  const ready = status === 'ready'
  const listed = contacts.find((contact) => contact.id === activeContactId) ?? null
  const active = listed ?? (pinned?.id === activeContactId ? pinned : null)
  const thread = active ? (messagesByContact[active.id] ?? []) : []
  const visibleThread = thread
  const matches = useMemo(() => {
    const needle = threadQuery.trim().toLowerCase()
    if (!needle) return [] as string[]
    return thread.filter((message) => (message.text || message.filename || '').toLowerCase().includes(needle)).map((message) => message.id)
  }, [thread, threadQuery])

  const gridItems = useMemo(() => {
    if (!mediaGrid) return [] as ChatMessage[]
    const seen = new Set<string>()
    const items: ChatMessage[] = []
    for (const rows of Object.values(messagesByContact)) {
      for (const message of rows) {
        if (!message.media || seen.has(message.media)) continue
        const gif =
          Boolean(message.gif) ||
          message.media.startsWith('data:image/gif') ||
          (message.filename || '').toLowerCase().endsWith('.gif')
        const keep = mediaGrid === 'sticker' ? message.kind === 'sticker' : gif
        if (!keep) continue
        seen.add(message.media)
        items.push(message)
      }
    }
    return items.slice(-24).reverse()
  }, [mediaGrid, messagesByContact])

  const pinnedMessage = [...thread].reverse().find((message) => message.pinned || (pinnedByContact[active?.id || ''] ?? []).includes(message.id))

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const list = lists.find((item) => item.id === listFilter)
    return contacts
      .filter((contact) => (showArchived ? contact.archived : !contact.archived))
      .filter((contact) => {
        if (list) return list.contactIds.includes(contact.id)
        if (listFilter === 'unread') return (contact.unread ?? 0) > 0
        if (listFilter === 'today') return contact.lastAt >= startOfToday()
        if (listFilter === 'pinned') return Boolean(contact.pinned)
        if (listFilter === 'groups') return contact.isGroup
        return true
      })
      .filter((contact) => !needle || contact.name.toLowerCase().includes(needle) || contact.phone.includes(needle))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastAt - a.lastAt)
  }, [contacts, query, listFilter, lists, showArchived])

  const visiblePeople = useMemo(() => {
    const needle = infoQuery.trim().toLowerCase()
    if (!needle) return profile.participants
    return profile.participants.filter(
      (person) => person.name.toLowerCase().includes(needle) || person.phone.includes(needle),
    )
  }, [profile.participants, infoQuery])

  const newestId = thread.at(-1)?.id
  useEffect(() => {
    const node = scroller.current
    if (!node) return
    if (pendingOlder.current) {
      node.scrollTop = Math.max(0, node.scrollHeight - olderHeight.current)
      pendingOlder.current = false
      loadingOlder.current = false
      return
    }
    if (!threadQuery && !jumpId) node.scrollTop = node.scrollHeight
  }, [newestId, thread.length, activeContactId, threadQuery])

  const draftContact = useRef<string | null>(null)
  useEffect(() => {
    if (draftContact.current) {
      drafts.current[draftContact.current] = draftRef.current
      saveDrafts(drafts.current)
    }
    draftContact.current = activeContactId
    const saved = activeContactId ? drafts.current[activeContactId] || '' : ''
    draftRef.current = saved
    setDraft(saved)
    setInfoOpen(false)
    setSearchOpen(false)
    setThreadQuery('')
    setProfile(emptyProfile)
    setMenuOpen(false)
    setSelecting(false)
    setPickedIds([])
    setReplyTo(null)
    setMentions([])
    setEmojiOpen(false)
    setLibrary(null)
    setMenuMessage(null)
    setCallNote(null)
    setPinDraft('')
    setPinError('')
    noMore.current = false
  }, [activeContactId, setPickedIds, setReplyTo])

  useEffect(() => {
    if (!activeContactId || draftContact.current !== activeContactId) return
    draftRef.current = draft
    drafts.current[activeContactId] = draft
    saveDrafts(drafts.current)
  }, [draft, activeContactId])

  useEffect(() => {
    if (!activeContactId || !draft.trim()) return
    sendTyping(activeContactId, true)
    const timer = window.setTimeout(() => sendTyping(activeContactId, false), 1600)
    return () => window.clearTimeout(timer)
  }, [draft, activeContactId, sendTyping])

  useEffect(() => {
    const needle = query.trim()
    if (needle.length < 2) {
      setHits([])
      return
    }
    const timer = window.setTimeout(() => {
      void searchAll(needle).then(setHits)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query, searchAll])

  useEffect(() => {
    setMatchAt(0)
  }, [threadQuery, activeContactId])

  useEffect(() => {
    const id = jumpId || matches[matchAt]
    if (!id || !threadQuery && !jumpId) return
    document.getElementById(`msg-${id}`)?.scrollIntoView({ block: 'center' })
    if (jumpId) setJumpId(null)
  }, [jumpId, matchAt, matches, thread, threadQuery])

  const mentionMatch = draft.match(/(^|\s)@([^\n@]*)$/)
  const mentionQuery = mentionMatch ? mentionMatch[2] ?? '' : null
  useEffect(() => {
    if (mentionQuery === null || !active?.isGroup || profile.participants.length) return
    void loadProfile(active.id).then(setProfile)
  }, [mentionQuery, active?.id, active?.isGroup, loadProfile, profile.participants.length])

  useEffect(() => {
    if (!browseRequest) return
    setShowArchived(false)
    setListFilter(browseRequest.mode)
  }, [browseRequest])

  useEffect(() => {
    setHitAt(0)
  }, [query])

  useEffect(() => {
    function allowFileDrop(event: DragEvent) {
      if (![...(event.dataTransfer?.types || [])].includes('Files')) return
      event.preventDefault()
    }
    window.addEventListener('dragover', allowFileDrop)
    window.addEventListener('drop', allowFileDrop)
    return () => {
      window.removeEventListener('dragover', allowFileDrop)
      window.removeEventListener('drop', allowFileDrop)
    }
  }, [])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        listSearchRef.current?.focus()
        listSearchRef.current?.select()
        return
      }
      if (event.key !== 'Escape') return
      if (lockSetup) setLockSetup(false)
      else if (mediaGrid) setMediaGrid(null)
      else if (statusOpen) setStatusOpen(false)
      else if (newChatOpen) setNewChatOpen(false)
      else if (menuMessage) setMenuMessage(null)
      else if (attachOpen) setAttachOpen(false)
      else if (emojiOpen) setEmojiOpen(false)
      else if (menuOpen) setMenuOpen(false)
      else if (infoOpen) setInfoOpen(false)
      else if (searchOpen) {
        setSearchOpen(false)
        setThreadQuery('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [attachOpen, emojiOpen, infoOpen, lockSetup, mediaGrid, menuMessage, menuOpen, newChatOpen, searchOpen, statusOpen])

  useEffect(() => {
    if (!uiRequest) return
    if (uiRequest.kind === 'close') {
      setActiveContactId(null)
      return
    }
    if (uiRequest.contactId !== activeContactId) setActiveContactId(uiRequest.contactId)
    if (uiRequest.kind === 'search') {
      setSearchOpen(true)
      if (uiRequest.detail) setThreadQuery(uiRequest.detail)
    }
    if (uiRequest.kind === 'select') setSelecting(true)
    if (uiRequest.kind === 'export') void downloadFull(uiRequest.contactId)
    if (uiRequest.kind === 'theme') applyTheme(uiRequest.detail)
    if (uiRequest.kind === 'lock') void toggleLock()
    if (uiRequest.kind === 'report') void sendReport()
    if (uiRequest.kind === 'info') {
      setInfoOpen(true)
      setInfoLoading(true)
      void loadProfile(uiRequest.contactId)
        .then(setProfile)
        .finally(() => setInfoLoading(false))
    }
  }, [uiRequest])

  function onCanvasScroll() {
    const node = scroller.current
    if (!node || !active || loadingOlder.current || threadQuery) return
    if (noMore.current || node.scrollHeight <= node.clientHeight + 8 || node.scrollTop > 48) return
    const oldest = thread[0]
    if (!oldest) return
    loadingOlder.current = true
    olderHeight.current = node.scrollHeight
    pendingOlder.current = true
    const known = thread.length
    void loadEarlier(active.id, oldest.at)
      .then((total) => {
        if (total <= known) {
          noMore.current = true
          pendingOlder.current = false
          loadingOlder.current = false
        }
      })
      .catch(() => {
        pendingOlder.current = false
        loadingOlder.current = false
      })
  }

  function fileKind(picked: File, force?: 'sticker' | 'gif') {
    if (force) return force
    const name = picked.name.toLowerCase()
    const type = picked.type.toLowerCase()
    if (type === 'image/gif' || name.endsWith('.gif')) return 'gif' as const
    if (type.startsWith('video/') || /\.(mp4|mov|webm|mkv)$/.test(name)) return 'video' as const
    if (type.startsWith('audio/') || /\.(mp3|ogg|wav|m4a|opus)$/.test(name)) return 'audio' as const
    if (type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|heic|heif)$/.test(name)) return 'photo' as const
    return 'document' as const
  }

  function openComputerFiles() {
    const input = attachRef.current
    if (!input) return
    input.accept = 'image/*,video/*,audio/*,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,.bmp,.mp4,.mov,.pdf,.doc,.docx,.txt'
    input.click()
  }

  async function onAttach(picked: File | undefined, force?: 'sticker' | 'gif') {
    if (!picked) return
    if (!active) {
      setAttachError('Abra uma conversa antes de soltar a imagem.')
      return
    }
    if (sending) return
    if (picked.size > 20 * 1024 * 1024) {
      setAttachError('Arquivo grande demais. O limite é 20 MB.')
      return
    }
    setAttachError('')
    let data = ''
    try {
      data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '')
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(picked)
      })
    } catch {
      setAttachError('Não deu para ler esse arquivo do notebook.')
      return
    }
    if (!data) {
      setAttachError('O arquivo veio vazio.')
      return
    }
    const kind = fileKind(picked, force)
    const mimetype = picked.type || (kind === 'photo' ? 'image/jpeg' : kind === 'gif' ? 'image/gif' : 'application/octet-stream')
    setSending(true)
    try {
      await sendFile({ name: picked.name, mimetype, data }, kind, draft.trim())
      setDraft('')
    } catch (error) {
      setAttachError(error instanceof Error ? error.message : 'Não deu para enviar a imagem.')
    } finally {
      setSending(false)
    }
  }

  async function toggleMic() {
    if (!active || sending) return
    if (recording && recorder.current) {
      recorder.current.stop()
      setRecording(false)
      return
    }
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch (error) {
      console.error(error)
      return
    }
    const media = new MediaRecorder(stream)
    recordChunks.current = []
    media.ondataavailable = (event) => {
      if (event.data.size) recordChunks.current.push(event.data)
    }
    media.onstop = () => {
      stream.getTracks().forEach((track) => track.stop())
      const blob = new Blob(recordChunks.current, { type: media.mimeType || 'audio/webm' })
      const reader = new FileReader()
      reader.onload = () => {
        const data = String(reader.result || '').split(',')[1] || ''
        void sendFile({ name: 'audio.webm', mimetype: blob.type || 'audio/webm', data }, 'audio')
      }
      reader.readAsDataURL(blob)
    }
    recorder.current = media
    media.start()
    setRecording(true)
  }

  async function handleSend() {
    if (!draft.trim() || sending) return
    setSending(true)
    try {
      await sendInChat(draft, mentions)
      setDraft('')
      setMentions([])
      setEmojiOpen(false)
    } catch (error) {
      console.error(error)
    } finally {
      setSending(false)
    }
  }

  async function downloadFull(contactId: string) {
    const contact = contacts.find((item) => item.id === contactId)
    const rows = await exportFull(contactId)
    downloadBlob(`${contact?.name || 'conversa'}.html`, chatExportHtml(contact?.name || 'Conversa', rows), 'text/html;charset=utf-8')
  }

  function applyTheme(detail?: string) {
    const order = ['default', 'doodle', 'green', 'sand'] as const
    const next = order.includes(detail as (typeof order)[number])
      ? (detail as (typeof order)[number])
      : order[(order.indexOf(theme) + 1) % order.length]!
    setTheme(next)
    if (active) noteCommand('Tema da conversa', `Tema ${next === 'default' ? 'escuro' : next === 'doodle' ? 'desenhado' : next === 'green' ? 'verde' : 'areia'}.`, [active.id])
  }

  async function toggleLock() {
    if (!active) return
    if (lockedIds.includes(active.id)) {
      const pin = window.prompt('PIN de 4 dígitos para destravar') || ''
      if (!unlockChat(active.id, pin)) noteCommand('Travar conversa', 'PIN incorreto.', [active.id])
      else {
        setUnlocked((current) => current.filter((id) => id !== active.id))
        noteCommand('Travar conversa', 'Conversa destravada.', [active.id])
      }
      return
    }
    const pin = window.prompt('Crie um PIN de 4 dígitos para travar esta conversa') || ''
    if (!lockChat(active.id, pin)) noteCommand('Travar conversa', 'Use 4 dígitos. Se já existe um PIN, ele precisa ser o mesmo.', [active.id])
    else noteCommand('Travar conversa', 'Conversa travada neste aparelho.', [active.id])
  }

  async function sendReport() {
    if (!active) return
    try {
      const message = await reportChat(active.id)
      noteCommand('Denunciar', message, [active.id])
    } catch (error) {
      noteCommand('Denunciar', error instanceof Error ? error.message : 'Falha ao denunciar', [active.id])
    }
  }

  function runMenu(label: string, action: CommandAction | 'local', detail?: string, local?: keyof typeof LOCAL_NOTES) {
    if (!active) return
    setMenuOpen(false)
    if (local === 'theme') {
      applyTheme(detail)
      return
    }
    if (local === 'lock') {
      void toggleLock()
      return
    }
    if (local === 'report') {
      void sendReport()
      return
    }
    if (local) {
      if (local === 'info' || local === 'search' || local === 'close' || local === 'export' || local === 'select') {
        requestUi(local, active.id)
      }
      noteCommand(label, LOCAL_NOTES[local], [active.id])
      return
    }
    void runCommand({ type: action as CommandAction, contactIds: [active.id], text: detail })
  }

  async function openInfo() {
    if (!active) return
    setInfoOpen(true)
    setInfoLoading(true)
    try {
      setProfile(await loadProfile(active.id))
    } finally {
      setInfoLoading(false)
    }
  }

  function openPerson(person: Pick<Participant, 'id' | 'name' | 'phone'>) {
    const known = contacts.find((contact) => contact.id === person.id)
    const next: Contact = known ?? {
      id: person.id,
      name: person.name,
      phone: person.phone,
      initials: initialsOf(person.name),
      color: colorFor(person.id),
      lastSeen: '',
      lastAt: 0,
      isGroup: person.id.includes('@g.us'),
    }
    setPinned(next)
    setActiveContactId(person.id)
    setInfoOpen(false)
  }

  const mentionPeople = (active?.isGroup && profile.participants.length ? profile.participants : contacts)
    .filter((person) => mentionQuery === null || person.name.toLowerCase().includes(mentionQuery.toLowerCase()))
    .slice(0, 6)

  function pickMention(person: { id: string; name: string }) {
    if (!mentionMatch) return
    const start = draft.lastIndexOf('@')
    setDraft(`${draft.slice(0, start)}@${person.name} `)
    setMentions((current) => (current.includes(person.id) ? current : [...current, person.id]))
  }

  return (
    <section className="zap">
      <aside className="zap-list">
        <header className="zap-list-head">
          {photos[me?.id || ''] ? (
            <img className="avatar me" src={photos[me?.id || '']} alt="" />
          ) : (
            <div className="avatar me">{me?.initials ?? 'WA'}</div>
          )}
          <div className="conn-meta">
            <strong>{me?.name ?? 'WhatsApp'}</strong>
            <span className={`conn-status is-${status}`}>
              <i />
              {statusLabel(status)}
            </span>
          </div>
          <div className="zap-list-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Status"
              onClick={() => {
                setStatusOpen(true)
                setStatusNote('')
                void loadStatuses().then(setStatuses)
              }}
            >
              <StatusIcon />
            </button>
            <button type="button" className="icon-btn" aria-label="Nova conversa" onClick={() => setNewChatOpen(true)}>
              <MessageIcon />
            </button>
            {ready ? (
              <button
                type="button"
                className="text-btn"
                onClick={() => {
                  const existing = savedPin()
                  if (existing) {
                    lockApp(existing)
                    return
                  }
                  setLockSetup(true)
                  setAppPin('')
                }}
              >
                Travar
              </button>
            ) : null}
            {ready ? (
              <button type="button" className="text-btn" onClick={logout}>
                Sair
              </button>
            ) : null}
          </div>
        </header>
        <div className="zap-search">
          <label className="zap-search-box">
            <SearchIcon size={16} />
            <input
              ref={listSearchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Pesquisar ou começar uma nova conversa"
              onKeyDown={(event) => {
                if (!hits.length) return
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  setHitAt((index) => (index + 1) % hits.length)
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  setHitAt((index) => (index - 1 + hits.length) % hits.length)
                }
                if (event.key === 'Enter') {
                  const hit = hits[hitAt]
                  if (!hit) return
                  event.preventDefault()
                  setActiveContactId(hit.contactId)
                  setSearchOpen(true)
                  setThreadQuery(hit.text.slice(0, 40))
                  setJumpId(hit.messageId)
                }
              }}
            />
          </label>
        </div>
        <div className="chat-filters">
          {[
            ['all', 'Todas'],
            ['unread', 'Não lidas'],
            ['today', 'Hoje'],
            ['pinned', 'Favoritos'],
            ['groups', 'Grupos'],
          ].map(([id, label]) => (
            <button key={id} type="button" className={listFilter === id && !showArchived ? 'is-on' : ''} onClick={() => { setShowArchived(false); setListFilter(id!) }}>
              {label}
            </button>
          ))}
          {lists.map((list) => (
            <button key={list.id} type="button" className={listFilter === list.id ? 'is-on' : ''} onClick={() => { setShowArchived(false); setListFilter(list.id) }}>
              {list.name}
            </button>
          ))}
          <button type="button" className={showArchived ? 'is-on' : ''} onClick={() => setShowArchived((open) => !open)}>
            Arquivadas
          </button>
        </div>
        <div className="chat-rows">
          {!ready ? (
            <p className="list-hint">Conecte pelo QR pra carregar suas conversas reais.</p>
          ) : filtered.length === 0 ? (
            <p className="list-hint">Sincronizando suas conversas... isso pode levar alguns segundos.</p>
          ) : (
            filtered.map((contact) => {
              const last = messagesByContact[contact.id]?.at(-1)
              const selected = contact.id === activeContactId
              return (
                <button
                  key={contact.id}
                  type="button"
                  className={`chat-row ${selected ? 'is-selected' : ''}`}
                  onClick={() => setActiveContactId(contact.id)}
                >
                  <Avatar contact={{ ...contact, photo: photos[contact.id] }} size={36} />
                  <div className="chat-row-body">
                    <div className="chat-row-top">
                      <span className="chat-row-name">
                        {contact.pinned ? <em className="row-flag">fixada</em> : null}
                        {contact.muted ? <em className="row-flag">silenciada</em> : null}
                        {contact.name}
                      </span>
                      <span className={`chat-row-time ${(contact.unread ?? 0) > 0 ? 'is-unread' : ''}`}>{last ? formatTime(last.at) : ''}</span>
                    </div>
                    <div className="chat-row-preview">
                      {last?.fromMe ? <Ticks status={last.status} /> : null}
                      <span>
                        {last?.authorName && !last.fromMe ? `${last.authorName.split(' ')[0]}: ` : ''}
                        {contact.typing || (last ? previewOf(last.text, last.kind) : contact.phone || 'Toque para conversar')}
                      </span>
                      {(contact.unread ?? 0) > 0 ? <b className="unread-badge">{contact.unread}</b> : null}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>
        {hits.length ? (
          <div className="search-hits">
            {hits.map((hit, index) => (
              <button
                key={`${hit.contactId}-${hit.messageId}`}
                type="button"
                className={index === hitAt ? 'is-active' : ''}
                onMouseEnter={() => setHitAt(index)}
                onClick={() => {
                  setActiveContactId(hit.contactId)
                  setSearchOpen(true)
                  setThreadQuery(hit.text.slice(0, 40))
                  setJumpId(hit.messageId)
                }}
              >
                <strong>{hit.contactName || 'Conversa'}</strong>
                <span>{hit.text}</span>
              </button>
            ))}
          </div>
        ) : null}
      </aside>

      <div
        className={`zap-thread ${dragging ? 'is-drag' : ''}`}
        onDragEnter={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          dragDepth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => {
          if (!event.dataTransfer.types.includes('Files')) return
          event.preventDefault()
          event.dataTransfer.dropEffect = 'copy'
          setDragging(true)
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setDragging(false)
        }}
        onDrop={(event) => {
          event.preventDefault()
          dragDepth.current = 0
          setDragging(false)
          void onAttach(event.dataTransfer.files[0])
        }}
      >
        {!ready ? (
          <div className="qr-screen">
            <h1>Use o Chat Zap no seu WhatsApp</h1>
            <p>
              No celular: <strong>WhatsApp → Aparelhos conectados → Conectar um aparelho</strong>
              <br />
              e aponte a câmera para o QR.
            </p>
            {qr ? (
              <img src={qr} alt="QR Code do WhatsApp" />
            ) : (
              <div className="qr-wait">Gerando QR e conectando...</div>
            )}
          </div>
        ) : active ? (
          <>
            <header className="zap-thread-head">
              <button type="button" className="thread-identity" onClick={() => void openInfo()}>
                <Avatar contact={{ ...active, photo: photos[active.id] }} size={40} />
                <div className="zap-thread-meta">
                  <strong>{active.name}</strong>
                  <span>
                    {active.typing
                      ? active.typing
                      : active.isGroup
                      ? profile.participants.length
                        ? `${profile.participants.length} participantes`
                        : 'ver dados do grupo'
                      : active.online
                        ? 'online'
                        : active.lastSeen || active.phone}
                  </span>
                </div>
              </button>
              <div className="zap-list-actions">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Pesquisar na conversa"
                  onClick={() => setSearchOpen((open) => !open)}
                >
                  <SearchSmallIcon size={20} />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="Opções da conversa"
                  onClick={() => setMenuOpen((open) => !open)}
                >
                  <DotsIcon />
                </button>
              </div>
            </header>
            {menuOpen ? (
              <div className="thread-menu" role="menu">
                <button type="button" onClick={() => runMenu('Dados do contato', 'local', undefined, 'info')}>Dados do contato</button>
                <button type="button" onClick={() => runMenu('Pesquisar', 'local', undefined, 'search')}>Pesquisar</button>
                <button type="button" onClick={() => runMenu('Selecionar mensagens', 'local', undefined, 'select')}>Selecionar mensagens</button>
                <button type="button" onClick={() => runMenu('Silenciar por 8 horas', 'mute', '8h')}>Silenciar por 8 horas</button>
                <button type="button" onClick={() => runMenu('Silenciar por 1 semana', 'mute', '1w')}>Silenciar por 1 semana</button>
                <button type="button" onClick={() => runMenu('Silenciar notificações', 'mute', 'forever')}>Silenciar sempre</button>
                <button type="button" onClick={() => runMenu('Ativar notificações', 'unmute')}>Ativar notificações</button>
                <button type="button" onClick={() => runMenu('Mensagens temporárias: 24 horas', 'disappearing', '86400')}>Temporárias: 24 horas</button>
                <button type="button" onClick={() => runMenu('Mensagens temporárias: 7 dias', 'disappearing', '604800')}>Temporárias: 7 dias</button>
                <button type="button" onClick={() => runMenu('Mensagens temporárias: 90 dias', 'disappearing', '7776000')}>Temporárias: 90 dias</button>
                <button type="button" onClick={() => runMenu('Desligar mensagens temporárias', 'disappearing', '0')}>Desligar temporárias</button>
                <button type="button" onClick={() => runMenu('Arquivar conversa', 'archive')}>Arquivar</button>
                <button type="button" onClick={() => runMenu('Desarquivar conversa', 'unarchive')}>Desarquivar</button>
                <button type="button" onClick={() => runMenu(lockedIds.includes(active.id) ? 'Destravar conversa' : 'Travar conversa', 'local', undefined, 'lock')}>{lockedIds.includes(active.id) ? 'Destravar conversa' : 'Travar conversa'}</button>
                <button type="button" onClick={() => runMenu('Tema da conversa', 'local', undefined, 'theme')}>Tema da conversa</button>
                <button type="button" onClick={() => runMenu('Adicionar aos favoritos', 'pin')}>Adicionar aos favoritos</button>
                <button
                  type="button"
                  onClick={() => {
                    const name = window.prompt('Nome da lista')
                    setMenuOpen(false)
                    if (name?.trim()) void runCommand({ type: 'label', contactIds: [active.id], text: name.trim() })
                  }}
                >
                  Adicionar à lista
                </button>
                <button type="button" onClick={() => runMenu('Exportar conversa', 'local', undefined, 'export')}>Exportar conversa</button>
                <button type="button" onClick={() => runMenu('Fechar conversa', 'local', undefined, 'close')}>Fechar conversa</button>
                <button type="button" onClick={() => void placeCall(active.id, false).then((result) => setCallNote({ message: result.message || result.error || 'Chamada', link: result.link }))}>Chamada de voz</button>
                <button type="button" onClick={() => void placeCall(active.id, true).then((result) => setCallNote({ message: result.message || result.error || 'Chamada', link: result.link }))}>Chamada de vídeo</button>
                <button type="button" onClick={() => runMenu('Denunciar', 'local', undefined, 'report')}>Denunciar</button>
                <button type="button" onClick={() => runMenu('Marcar como não lida', 'unread')}>Marcar como não lida</button>
                <button type="button" onClick={() => runMenu('Limpar conversa', 'clear')}>Limpar conversa</button>
                <button type="button" onClick={() => runMenu('Bloquear contato', 'block')}>Bloquear</button>
              </div>
            ) : null}
            {pinnedMessage ? (
              <button
                type="button"
                className="pin-banner"
                onClick={() => setJumpId(pinnedMessage.id)}
              >
                <strong>Mensagem fixada</strong>
                <span>{(pinnedMessage.text || pinnedMessage.filename || pinnedMessage.kind || 'mensagem').slice(0, 90)}</span>
              </button>
            ) : null}
            {searchOpen ? (
              <div className="thread-search">
                <SearchIcon size={16} />
                <input
                  ref={threadSearchRef}
                  value={threadQuery}
                  onChange={(event) => setThreadQuery(event.target.value)}
                  placeholder="Pesquisar nesta conversa"
                  autoFocus
                  onKeyDown={(event) => {
                    if (!matches.length) return
                    if (event.key === 'ArrowDown') {
                      event.preventDefault()
                      setMatchAt((index) => (index + 1) % matches.length)
                    }
                    if (event.key === 'ArrowUp') {
                      event.preventDefault()
                      setMatchAt((index) => (index - 1 + matches.length) % matches.length)
                    }
                  }}
                />
                {matches.length ? (
                  <>
                    <span>{matchAt + 1}/{matches.length}</span>
                    <button type="button" onClick={() => setMatchAt((index) => (index - 1 + matches.length) % matches.length)}>Anterior</button>
                    <button type="button" onClick={() => setMatchAt((index) => (index + 1) % matches.length)}>Próxima</button>
                  </>
                ) : null}
              </div>
            ) : null}
            <div className={`zap-canvas theme-${theme}`} ref={scroller} onScroll={onCanvasScroll}>
              {lockedIds.includes(active.id) && !unlocked.includes(active.id) ? (
                <form
                  className="lock-gate"
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (!unlockPin(pinDraft)) {
                      setPinError('PIN incorreto')
                      return
                    }
                    setUnlocked((current) => [...current, active.id])
                    setPinError('')
                    setPinDraft('')
                  }}
                >
                  <strong>Conversa travada</strong>
                  <input value={pinDraft} onChange={(event) => setPinDraft(event.target.value)} inputMode="numeric" maxLength={4} placeholder="PIN de 4 dígitos" />
                  {pinError ? <em>{pinError}</em> : null}
                  <button type="submit">Abrir</button>
                </form>
              ) : visibleThread.map((message) => {
                const sticker = message.kind === 'sticker' && message.media
                const photo = message.kind === 'image' && message.media
                const audio = message.kind === 'audio' && message.media
                const video = message.kind === 'video' && message.media
                const caption = captionOf(message.text)
                const hasCaption = Boolean(caption) && message.kind !== 'document'
                return (
                  <div
                    key={message.id}
                    id={`msg-${message.id}`}
                    className={`bubble-row ${message.fromMe ? 'is-out' : 'is-in'} ${pickedIds.includes(message.id) ? 'is-picked' : ''} ${matches[matchAt] === message.id ? 'is-hit' : ''}`}
                    onClick={() => {
                      if (!selecting) return
                      setPickedIds((current) =>
                        current.includes(message.id)
                          ? current.filter((id) => id !== message.id)
                          : [...current, message.id],
                      )
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setMenuMessage(message)
                      setMenuPos({ x: event.clientX, y: event.clientY })
                    }}
                  >
                    <div
                      className={`bubble ${message.fromMe ? 'out' : 'in'} ${sticker ? 'is-sticker' : ''} ${photo || video ? 'is-media' : ''} ${hasCaption ? 'has-caption' : ''} ${audio ? 'is-audio' : ''} ${message.kind === 'document' ? 'is-doc' : ''} ${message.poll ? 'is-poll' : ''}`}
                    >
                      {message.viaBlast ? <em className="blast-tag">via disparo</em> : null}
                      {active.isGroup && message.authorName && !message.fromMe ? (
                        <button
                          type="button"
                          className="bubble-author"
                          onClick={() =>
                            message.authorId &&
                            openPerson({
                              id: message.authorId,
                              name: message.authorName || 'Contato',
                              phone: '',
                            })
                          }
                        >
                          {message.authorName}
                        </button>
                      ) : null}
                      {message.quote ? <div className="bubble-quote">{message.quote.text || 'mensagem'}</div> : null}
                      {message.starred ? <span className="star-mark">★</span> : null}
                      {sticker || photo ? (
                        <img src={message.media} alt={sticker ? 'Figurinha' : caption || 'Foto'} />
                      ) : null}
                      {audio ? <VoiceNote src={message.media || ''} duration={message.duration} /> : null}
                      {video ? <video controls preload="metadata" src={message.media} /> : null}
                      {message.kind === 'document' ? (
                        <a className="doc-link" href={message.media || '#'} download={message.filename || message.text || 'documento'}>
                          {message.filename || message.text || 'Documento'}
                        </a>
                      ) : null}
                      {message.poll ? (
                        <PollBubble poll={message.poll} onVote={(optionIds) => votePoll(active.id, message.id, optionIds)} />
                      ) : null}
                      {caption && message.kind !== 'document' && !message.poll ? (
                        <p>
                          <MessageText text={caption} />
                        </p>
                      ) : null}
                      {!message.media && (message.kind === 'audio' || message.kind === 'video' || message.kind === 'sticker' || message.kind === 'image' || message.kind === 'document') ? (
                        <button type="button" className="media-fetch" onClick={() => void fetchMedia(active.id, message.id)}>
                          Baixar {message.kind === 'audio' ? 'áudio' : message.kind === 'video' ? 'vídeo' : message.kind === 'document' ? 'documento' : message.kind === 'sticker' ? 'figurinha' : 'foto'}
                        </button>
                      ) : null}
                      {message.reactions?.length ? (
                        <div className="reactions">
                          {message.reactions.map((reaction) => (
                            <span key={`${reaction.emoji}-${reaction.author || ''}`}>{reaction.emoji}</span>
                          ))}
                        </div>
                      ) : null}
                      <span className="bubble-meta">
                        {formatClock(message.at)}
                        {message.fromMe ? <Ticks status={message.status} /> : null}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
            {selecting ? (
              <div className="select-bar">
                <span>{pickedIds.length} selecionada(s)</span>
                <button
                  type="button"
                  onClick={() => {
                    const message = thread.find((item) => item.id === pickedIds[0]) ?? thread.at(-1)
                    if (message) setReplyTo({ id: message.id, preview: (message.text || message.kind || 'mensagem').slice(0, 80) })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Responder
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runCommand({ type: 'react', contactIds: [active.id], text: '👍', messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  👍
                </button>
                {['❤️', '😂', '😮', '😢', '🙏'].map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    onClick={() => {
                      void runCommand({ type: 'react', contactIds: [active.id], text: emoji, messageIds: pickedIds })
                      setSelecting(false)
                      setPickedIds([])
                    }}
                  >
                    {emoji}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    const text = thread.filter((item) => pickedIds.includes(item.id)).map((item) => item.text || item.kind || '').join('\n')
                    void navigator.clipboard.writeText(text)
                  }}
                >
                  Copiar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const message = thread.find((item) => item.id === pickedIds[0])
                    if (!message) return
                    if (message.media) {
                      const link = document.createElement('a')
                      link.href = message.media
                      link.download = message.filename || 'arquivo'
                      link.click()
                      return
                    }
                    void fetchMedia(active.id, message.id)
                  }}
                >
                  Baixar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runCommand({ type: 'unstar', contactIds: [active.id], messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Tirar estrela
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runCommand({ type: 'unpinmsg', contactIds: [active.id], messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Desafixar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const message = thread.find((item) => item.id === pickedIds[0])
                    if (!message) return
                    void readMessageInfo(message.id)
                      .then((info) => setInfoNote(`Lida: ${info.read.join(', ') || 'ninguém'} · Entregue: ${info.delivered.join(', ') || 'ninguém'}`))
                      .catch((error) => setInfoNote(error instanceof Error ? error.message : 'Sem informações'))
                  }}
                >
                  Info
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const name = window.prompt('Encaminhar para quem?')
                    const found = contacts.find((contact) => contact.name.toLowerCase().includes((name || '').trim().toLowerCase()))
                    if (name && found) void runCommand({ type: 'forward', contactIds: [found.id], messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Encaminhar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runCommand({ type: 'star', contactIds: [active.id], messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Estrela
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const text = window.prompt('Novo texto da mensagem')
                    if (text?.trim()) void runCommand({ type: 'edit', contactIds: [active.id], text: text.trim(), messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runCommand({ type: 'pinmsg', contactIds: [active.id], messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Fixar
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runCommand({ type: 'delete', contactIds: [active.id], text: 'me', messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Para mim
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void runCommand({ type: 'delete', contactIds: [active.id], text: 'everyone', messageIds: pickedIds })
                    setSelecting(false)
                    setPickedIds([])
                  }}
                >
                  Para todos
                </button>
                <button type="button" onClick={() => { setSelecting(false); setPickedIds([]) }}>
                  Cancelar
                </button>
              </div>
            ) : null}
            {replyTo ? (
              <div className="reply-bar">
                <span>Respondendo: {replyTo.preview}</span>
                <button type="button" onClick={() => setReplyTo(null)}>Cancelar</button>
              </div>
            ) : null}
            {mentionQuery !== null && mentionPeople.length ? (
              <div className="mention-list">
                {mentionPeople.map((person) => (
                  <button key={person.id} type="button" onClick={() => pickMention(person)}>
                    {person.name}
                  </button>
                ))}
              </div>
            ) : null}
            {emojiOpen ? (
              <div className="emoji-pop">
                {EMOJIS.map((emoji) => (
                  <button key={emoji} type="button" onClick={() => setDraft((current) => `${current}${emoji}`)}>
                    {emoji}
                  </button>
                ))}
              </div>
            ) : null}
            {infoNote ? <p className="list-hint">{infoNote}</p> : null}
            {callNote ? (
              <div className="call-note">
                <span>{callNote.message}</span>
                {callNote.link ? (
                  <button type="button" onClick={() => void sendInChat(callNote.link || '')}>Enviar link</button>
                ) : null}
                <button type="button" onClick={() => setCallNote(null)}>Fechar</button>
              </div>
            ) : null}
            {attachOpen ? (
              <div className="attach-menu">
                <button type="button" onClick={() => { setAttachOpen(false); openComputerFiles() }}>Foto, vídeo ou documento</button>
                <button
                  type="button"
                  onClick={() => {
                    const text = window.prompt('Enquete: Pergunta | opção 1 | opção 2')
                    setAttachOpen(false)
                    if (text?.includes('|')) void runCommand({ type: 'poll', contactIds: [active.id], text })
                  }}
                >
                  Enquete
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const name = window.prompt('Nome do contato')
                    const phone = window.prompt('Telefone com DDD')
                    setAttachOpen(false)
                    if (name && phone) void runCommand({ type: 'contact', contactIds: [active.id], text: `${name}|${phone}` })
                  }}
                >
                  Contato
                </button>
                <button type="button" onClick={() => { setAttachOpen(false); setMediaGrid('sticker') }}>Figurinha</button>
                <button type="button" onClick={() => { setAttachOpen(false); setMediaGrid('gif') }}>GIF</button>
              </div>
            ) : null}
            {mediaGrid ? (
              <div className="media-grid">
                <header>
                  <strong>{mediaGrid === 'sticker' ? 'Figurinhas' : 'GIFs'}</strong>
                  <button
                    type="button"
                    onClick={() => {
                      attachRef.current?.setAttribute('accept', mediaGrid === 'sticker' ? 'image/webp,image/png' : 'image/gif,video/mp4')
                      attachRef.current?.click()
                    }}
                  >
                    Do arquivo
                  </button>
                  <button type="button" onClick={() => setMediaGrid(null)}>Fechar</button>
                </header>
                {gridItems.length === 0 ? (
                  <p>Nada carregado ainda. Use “Do arquivo” ou abra uma conversa que já tenha {mediaGrid === 'sticker' ? 'figurinha' : 'GIF'}.</p>
                ) : (
                  <div>
                    {gridItems.map((message) => (
                      <button
                        key={message.id}
                        type="button"
                        onClick={() => {
                          const file = fileFromMedia(message)
                          if (!file || !active) return
                          setMediaGrid(null)
                          setSending(true)
                          void sendFile(file, mediaGrid, draft.trim())
                            .then(() => setDraft(''))
                            .finally(() => setSending(false))
                        }}
                      >
                        <img src={message.media} alt="" />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : null}
            {dragging ? <div className="drop-veil">Solte a imagem para enviar</div> : null}
            {attachError ? <p className="attach-error">{attachError}</p> : null}
            <form
              className="zap-composer"
              onSubmit={(event) => {
                event.preventDefault()
                void handleSend()
              }}
              onPaste={(event) => {
                const pasted = event.clipboardData.files[0]
                if (pasted) {
                  event.preventDefault()
                  void onAttach(pasted)
                  return
                }
                const image = [...event.clipboardData.items].find((item) => item.type.startsWith('image/'))?.getAsFile()
                if (!image) return
                event.preventDefault()
                void onAttach(image)
              }}
            >
              <button type="button" className="icon-btn" aria-label="Emoji" onClick={() => setEmojiOpen((open) => !open)}>
                <SmileIcon />
              </button>
              <button type="button" className="icon-btn" aria-label="Anexar" onClick={() => setAttachOpen((open) => !open)}>
                <AttachIcon />
              </button>
              <button type="button" className="photo-btn" onClick={openComputerFiles}>
                Foto
              </button>
              <input
                ref={attachRef}
                className="file-input"
                type="file"
                accept="image/*,video/*,audio/*,application/pdf,.png,.jpg,.jpeg,.webp,.gif,.heic,.bmp"
                onChange={(event) => {
                  const picked = event.target.files?.[0]
                  event.target.value = ''
                  const force = mediaGrid
                  setMediaGrid(null)
                  void onAttach(picked, force ?? undefined)
                }}
              />
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={replyTo ? `Respondendo: ${replyTo.preview}` : 'Digite uma mensagem'}
              />
              {draft.trim() ? (
                <button type="submit" className="icon-btn send" aria-label="Enviar" disabled={sending}>
                  <SendIcon />
                </button>
              ) : (
                <button
                  type="button"
                  className={`icon-btn ${recording ? 'is-recording' : ''}`}
                  aria-label="Áudio"
                  onClick={() => void toggleMic()}
                >
                  <MicIcon />
                </button>
              )}
            </form>
            {infoOpen ? (
              <aside className="info-panel">
                <header className="info-head">
                  <strong>{active.isGroup ? 'Dados do grupo' : 'Dados do contato'}</strong>
                  <button type="button" className="icon-btn" aria-label="Fechar" onClick={() => setInfoOpen(false)}>
                    <CloseIcon />
                  </button>
                </header>
                <div className="info-scroll">
                  <div className="info-contact">
                    <Avatar contact={{ ...active, photo: photos[active.id] }} size={96} />
                    <strong>{active.name}</strong>
                    <span>
                      {active.isGroup
                        ? profile.participants.length
                          ? `${profile.participants.length} participantes`
                          : 'Grupo'
                        : profile.phone || active.phone || 'Sem telefone visível'}
                    </span>
                    <button
                      type="button"
                      className="info-search"
                      aria-label="Pesquisar na conversa"
                      onClick={() => {
                        setInfoOpen(false)
                        setSearchOpen(true)
                      }}
                    >
                      <SearchIcon size={18} />
                    </button>
                  </div>
                  <section className="info-section">
                    <h3>Sobre</h3>
                    {profile.description ? (
                      <p className="info-desc">
                        <MessageText text={profile.description} />
                      </p>
                    ) : null}
                    <button type="button" className="info-row" onClick={() => setLibrary('media')}>
                      <span>Mídia, links e docs</span>
                      <em>{profile.media + profile.links + profile.docs}</em>
                    </button>
                    <button type="button" className="info-row" onClick={() => setLibrary('starred')}>
                      <span>Mensagens favoritas</span>
                      <em>{profile.starred}</em>
                    </button>
                    <div className="info-row">
                      <span>Notificações</span>
                      <em>{profile.muted ? 'Silenciadas' : 'Ativas'}</em>
                    </div>
                    <div className="info-row">
                      <span>Mensagens temporárias</span>
                      <em>{profile.disappearing}</em>
                    </div>
                    {infoLoading ? <p className="list-hint">Carregando dados...</p> : null}
                    {library ? (
                      <div className="library-list">
                        <div className="library-tabs">
                          {(['media', 'links', 'docs', 'starred'] as const).map((tab) => (
                            <button key={tab} type="button" className={library === tab ? 'is-on' : ''} onClick={() => setLibrary(tab)}>
                              {tab === 'media' ? 'Mídia' : tab === 'links' ? 'Links' : tab === 'docs' ? 'Docs' : 'Estrelas'}
                            </button>
                          ))}
                        </div>
                        {(library === 'media' ? profile.mediaItems : library === 'links' ? profile.linkItems : library === 'docs' ? profile.docItems : profile.starredItems).map((item: LibraryItem) => (
                          <button
                            key={`${item.kind}-${item.id}`}
                            type="button"
                            className="library-item"
                            onClick={() => {
                              setJumpId(item.id)
                              setInfoOpen(false)
                              if (library === 'links') setThreadQuery(item.text)
                            }}
                          >
                            {item.text || item.kind}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </section>
                  {active.isGroup ? (
                    <section className="info-section">
                      <h3>{profile.participants.length} participantes</h3>
                      <div className="group-actions">
                        <button
                          type="button"
                          onClick={() => {
                            const phone = window.prompt('Número de quem entra, com DDD')
                            if (!phone) return
                            void groupAction({ contactId: active.id, action: 'add', participantId: `${phone.replace(/\D/g, '')}@c.us` })
                              .then(setGroupNote)
                              .catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                          }}
                        >
                          Adicionar
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const name = window.prompt('Novo nome do grupo')
                            if (!name) return
                            void groupAction({ contactId: active.id, action: 'subject', text: name }).then(setGroupNote).catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                          }}
                        >
                          Nome
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            const text = window.prompt('Descrição do grupo', profile.description)
                            if (text === null) return
                            void groupAction({ contactId: active.id, action: 'description', text }).then(setGroupNote).catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                          }}
                        >
                          Descrição
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void groupAction({ contactId: active.id, action: 'invite' }).then(setGroupNote).catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                          }}
                        >
                          Link
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void groupAction({ contactId: active.id, action: 'leave' }).then(setGroupNote).catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                          }}
                        >
                          Sair
                        </button>
                        <label className="file-label">
                          Foto
                          <input
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(event) => {
                              const picked = event.target.files?.[0]
                              event.target.value = ''
                              if (!picked) return
                              const reader = new FileReader()
                              reader.onload = () => {
                                const data = String(reader.result || '').split(',')[1] || ''
                                void groupAction({
                                  contactId: active.id,
                                  action: 'picture',
                                  file: { name: picked.name, mimetype: picked.type || 'image/jpeg', data },
                                })
                                  .then(setGroupNote)
                                  .catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                              }
                              reader.readAsDataURL(picked)
                            }}
                          />
                        </label>
                      </div>
                      {groupNote ? <p className="list-hint">{groupNote}</p> : null}
                      <div className="zap-search">
                        <label className="zap-search-box">
                          <SearchIcon size={16} />
                          <input
                            value={infoQuery}
                            onChange={(event) => setInfoQuery(event.target.value)}
                            placeholder="Pesquisar participante"
                          />
                        </label>
                      </div>
                      {!infoLoading && visiblePeople.length === 0 ? (
                        <p className="list-hint">Nenhum participante encontrado.</p>
                      ) : null}
                      {visiblePeople.map((person) => (
                        <div
                          key={person.id}
                          className="chat-row"
                          onClick={() => openPerson(person)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') openPerson(person)
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          <Avatar
                            contact={{
                              initials: initialsOf(person.name),
                              color: colorFor(person.id),
                              photo: photos[person.id],
                            }}
                            size={36}
                          />
                          <div className="chat-row-body">
                            <div className="chat-row-top">
                              <span className="chat-row-name">{person.name}</span>
                              {person.isAdmin ? <span className="admin-tag">admin</span> : null}
                            </div>
                            <div className="chat-row-preview">
                              <span>{person.phone || 'abrir conversa'}</span>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void groupAction({ contactId: active.id, action: 'promote', participantId: person.id }).then(setGroupNote).catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                                }}
                              >
                                Admin
                              </button>
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation()
                                  void groupAction({ contactId: active.id, action: person.isAdmin ? 'demote' : 'remove', participantId: person.id }).then(setGroupNote).catch((error) => setGroupNote(error instanceof Error ? error.message : 'Falha'))
                                }}
                              >
                                {person.isAdmin ? 'Rebaixar' : 'Remover'}
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </section>
                  ) : (
                    <section className="info-section">
                      <h3>
                        {profile.commonGroups.length
                          ? `${profile.commonGroups.length} grupos em comum`
                          : 'Grupos em comum'}
                      </h3>
                      {!infoLoading && profile.commonGroups.length === 0 ? (
                        <p className="list-hint">Nenhum grupo em comum.</p>
                      ) : null}
                      {profile.commonGroups.map((group) => (
                        <button
                          key={group.id}
                          type="button"
                          className="chat-row"
                          onClick={() => openPerson({ id: group.id, name: group.name, phone: '' })}
                        >
                          <Avatar
                            contact={{
                              initials: initialsOf(group.name),
                              color: colorFor(group.id),
                              photo: photos[group.id],
                            }}
                            size={36}
                          />
                          <div className="chat-row-body">
                            <div className="chat-row-top">
                              <span className="chat-row-name">{group.name}</span>
                            </div>
                            {group.preview ? (
                              <div className="chat-row-preview">
                                <span>{group.preview}</span>
                              </div>
                            ) : null}
                          </div>
                        </button>
                      ))}
                    </section>
                  )}
                </div>
              </aside>
            ) : null}
          </>
        ) : (
          <div className="zap-empty">
            <p>Selecione uma conversa à esquerda</p>
          </div>
        )}
      </div>
      {menuMessage ? (
        <>
          <button type="button" className="scrim" aria-label="Fechar menu" onClick={() => setMenuMessage(null)} />
          <div className="msg-menu" style={{ top: menuPos.y, left: menuPos.x }}>
            <button type="button" onClick={() => { setReplyTo({ id: menuMessage.id, preview: (menuMessage.text || menuMessage.kind || 'mensagem').slice(0, 80) }); setMenuMessage(null) }}>Responder</button>
            <button type="button" onClick={() => { void navigator.clipboard.writeText(menuMessage.text || ''); setMenuMessage(null) }}>Copiar</button>
            <button type="button" onClick={() => { setPickedIds([menuMessage.id]); setSelecting(true); setMenuMessage(null) }}>Selecionar</button>
            <button type="button" onClick={() => { void runCommand({ type: menuMessage.starred ? 'unstar' : 'star', contactIds: [active?.id || menuMessage.contactId], messageIds: [menuMessage.id] }); setMenuMessage(null) }}>{menuMessage.starred ? 'Tirar estrela' : 'Estrela'}</button>
            <button type="button" onClick={() => { if (menuMessage.media) { const link = document.createElement('a'); link.href = menuMessage.media; link.download = menuMessage.filename || 'arquivo'; link.click() } else void fetchMedia(menuMessage.contactId, menuMessage.id); setMenuMessage(null) }}>Baixar</button>
            <button type="button" onClick={() => { void readMessageInfo(menuMessage.id).then((info) => setInfoNote(`Lida: ${info.read.join(', ') || 'ninguém'} · Entregue: ${info.delivered.join(', ') || 'ninguém'}`)); setMenuMessage(null) }}>Info</button>
          </div>
        </>
      ) : null}
      {newChatOpen ? (
        <form
          className="modal"
          onSubmit={(event) => {
            event.preventDefault()
            void openNumber(newPhone)
              .then(() => {
                setNewChatOpen(false)
                setNewPhone('')
              })
              .catch((error) => setStatusNote(error instanceof Error ? error.message : 'Número inválido'))
          }}
        >
          <strong>Nova conversa</strong>
          <input value={newPhone} onChange={(event) => setNewPhone(event.target.value)} placeholder="Número com DDI e DDD" />
          {statusNote && !statusOpen ? <em>{statusNote}</em> : null}
          <div>
            <button type="button" onClick={() => setNewChatOpen(false)}>Cancelar</button>
            <button type="submit">Abrir</button>
          </div>
        </form>
      ) : null}
      {lockSetup ? (
        <form
          className="modal"
          onSubmit={(event) => {
            event.preventDefault()
            if (!lockApp(appPin)) {
              setStatusNote('Use 4 dígitos. Se já existe um PIN, ele precisa ser o mesmo.')
              return
            }
            setLockSetup(false)
            setAppPin('')
          }}
        >
          <strong>Travar o Chat Zap</strong>
          <input
            value={appPin}
            onChange={(event) => setAppPin(event.target.value.replace(/\D/g, '').slice(0, 4))}
            inputMode="numeric"
            placeholder="Crie um PIN de 4 dígitos"
          />
          <div>
            <button type="button" onClick={() => setLockSetup(false)}>Cancelar</button>
            <button type="submit">Travar</button>
          </div>
        </form>
      ) : null}
      {statusOpen ? (
        <aside className="status-panel">
          <header>
            <strong>Status</strong>
            <button type="button" onClick={() => setStatusOpen(false)}>Fechar</button>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (!statusText.trim() && !statusFile) return
              void postStatus(statusText, statusFile ?? undefined)
                .then((message) => {
                  setStatusNote(message)
                  setStatusText('')
                  setStatusFile(null)
                  return loadStatuses().then(setStatuses)
                })
                .catch((error) => setStatusNote(error instanceof Error ? error.message : 'Falha ao publicar'))
            }}
          >
            <input value={statusText} onChange={(event) => setStatusText(event.target.value)} placeholder="Texto do status" />
            <label className="text-btn">
              Foto
              <input
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  const picked = event.target.files?.[0]
                  event.target.value = ''
                  if (!picked) return
                  const reader = new FileReader()
                  reader.onload = () => {
                    const result = String(reader.result || '')
                    const comma = result.indexOf(',')
                    setStatusFile({
                      name: picked.name,
                      mimetype: picked.type || 'image/jpeg',
                      data: comma >= 0 ? result.slice(comma + 1) : result,
                    })
                  }
                  reader.readAsDataURL(picked)
                }}
              />
            </label>
            {statusFile ? (
              <img className="status-preview" src={`data:${statusFile.mimetype};base64,${statusFile.data}`} alt="" />
            ) : null}
            <button type="submit">Publicar</button>
          </form>
          {statusNote ? <p>{statusNote}</p> : null}
          {statuses.length === 0 ? <p>Nenhum status carregado.</p> : null}
          {statuses.map((item) => (
            <article key={item.id}>
              <strong>{item.name}</strong>
              <span>{item.text || 'Status sem texto'}</span>
            </article>
          ))}
        </aside>
      ) : null}
    </section>
  )
}
