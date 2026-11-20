export type ConnectionStatus = 'idle' | 'qr' | 'connecting' | 'ready' | 'offline'

export type MeUser = {
  id: string
  name: string
  initials: string
}

export type Contact = {
  id: string
  name: string
  phone: string
  initials: string
  color: string
  lastSeen: string
  online?: boolean
  lastAt: number
  isGroup: boolean
  unread?: number
  muted?: boolean
  pinned?: boolean
  archived?: boolean
  typing?: string
}

export type PollOption = {
  /** WhatsApp's localId for the option (what a vote refers to). */
  id: number
  name: string
  votes: number
  /** Display names of who picked this option ("Você" for you). */
  voters: string[]
  /** You picked this option. */
  mine: boolean
}

export type Poll = {
  name: string
  /** More than one option can be picked. */
  multi: boolean
  options: PollOption[]
  /** How many people voted (each person counts once, even with several options). */
  voters: number
}

export type ChatMessage = {
  id: string
  contactId: string
  text: string
  fromMe: boolean
  at: number
  viaBlast?: boolean
  status: 'sent' | 'delivered' | 'read'
  kind?: 'text' | 'sticker' | 'image' | 'audio' | 'video' | 'document'
  media?: string
  authorId?: string
  authorName?: string
  duration?: number
  starred?: boolean
  pinned?: boolean
  gif?: boolean
  quote?: { id: string; text: string }
  reactions?: { emoji: string; fromMe: boolean; author?: string }[]
  poll?: Poll
  filename?: string
}

export type Participant = {
  id: string
  name: string
  phone: string
  isAdmin: boolean
}

export type CommonGroup = {
  id: string
  name: string
  preview: string
}

export type LibraryItem = {
  id: string
  kind: string
  text: string
  at: number
}

export type ChatProfile = {
  description: string
  phone: string
  muted: boolean
  disappearing: string
  media: number
  links: number
  docs: number
  starred: number
  participants: Participant[]
  commonGroups: CommonGroup[]
  mediaItems: LibraryItem[]
  linkItems: LibraryItem[]
  docItems: LibraryItem[]
  starredItems: LibraryItem[]
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

export type CommandMessage = {
  id: string
  role: 'user' | 'system'
  text: string
  contactIds?: string[]
  at: number
}

export type ConnectionState = {
  status: ConnectionStatus
  qr: string | null
  me: MeUser | null
}

export type BlastProgress = {
  contactId: string
  name: string
  ok: boolean
  error?: string
  index: number
  total: number
}
