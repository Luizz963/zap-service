import { createServer } from 'node:http'
import { Server } from 'socket.io'
import { decide, type AgentContext } from './agent.ts'
import type { CommandAction, CommandFile } from './whatsapp.ts'

// `npm run dev:fake` (or `--fake`) swaps in a fake WhatsApp with invented chats, for safe testing.
// The real module is only loaded when needed, so the fake never opens your WhatsApp session.
const FAKE = process.argv.includes('--fake') || process.env.FAKE_WHATSAPP === '1'
type WhatsAppApi = typeof import('./whatsapp.ts')
// Typed as the real module: the build fails if the fake ever stops matching it.
const wa: WhatsAppApi = FAKE ? await import('./fake-whatsapp.ts') : await import('./whatsapp.ts')
const {
  destroyWhatsApp,
  exportHistory,
  fetchMessageMedia,
  getState,
  groupAction,
  hydrateCache,
  listChats,
  listMessages,
  listPhotos,
  listStatuses,
  loadEarlier,
  loadProfile,
  loadThread,
  logout,
  markRead,
  messageInfo,
  votePoll,
  openNumber,
  postStatus,
  reportChat,
  runWhatsAppCommand,
  searchMessages,
  sendBlast,
  sendChatFile,
  sendText,
  sendTyping,
  startCall,
  startWhatsApp,
  watchChat,
  waEvents,
} = wa
if (FAKE) console.log('[fake] Servidor em MODO TESTE: usando o WhatsApp de mentira (server/fake-whatsapp.ts)')

const PORT = Number(process.env.PORT || 3001)
// Only this computer can connect. There's no login on the socket, so listening on every
// network interface would let anyone on the same Wi-Fi read and send your WhatsApp messages.
const HOST = process.env.HOST || '127.0.0.1'

/**
 * A user-facing error message. Errors thrown inside the WhatsApp page come back with the
 * page's stack trace appended ("msgOf (pptr:evaluate;runPageJob…"), so keep only the first line.
 */
function errorText(error: unknown, fallback: string) {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const first = raw.split('\n')[0]?.replace(/^Error:\s*/, '').trim()
  return first || fallback
}

const httpServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: true, ...getState() }))
})

const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 4e7,
})

function snapshot() {
  const chats = listChats()
  const messagesByContact: Record<string, ReturnType<typeof listMessages>> = {}
  for (const chat of chats) messagesByContact[chat.id] = listMessages(chat.id)
  return {
    ...getState(),
    chats,
    messagesByContact,
  }
}

io.on('connection', (socket) => {
  socket.emit('snapshot', snapshot())
  const cachedPhotos = listPhotos()
  if (cachedPhotos.length) socket.emit('photos', cachedPhotos)

  socket.on(
    'send',
    async (
      {
        contactId,
        text,
        quotedMessageId,
        quoteText,
        mentions,
      }: { contactId?: string; text?: string; quotedMessageId?: string; quoteText?: string; mentions?: string[] },
      ack,
    ) => {
      try {
        if (!contactId || !text?.trim()) throw new Error('Mensagem vazia')
        const message = await sendText(
          contactId,
          text.trim(),
          false,
          quotedMessageId ? { id: quotedMessageId, text: quoteText || 'mensagem' } : undefined,
          mentions ?? [],
        )
        ack?.({ ok: true, message })
      } catch (error) {
        ack?.({ ok: false, error: errorText(error, 'Falha ao enviar') })
      }
    },
  )

  socket.on(
    'send-media',
    async (
      payload: {
        contactId?: string
        file?: CommandFile
        kind?: 'photo' | 'audio' | 'video' | 'document' | 'sticker' | 'gif'
        caption?: string
      },
      ack,
    ) => {
      try {
        if (!payload?.contactId || !payload.file || !payload.kind) throw new Error('Arquivo inválido')
        const message = await sendChatFile(payload.contactId, payload.file, payload.kind, payload.caption || '')
        ack?.({ ok: true, message })
      } catch (error) {
        console.error('[zap] falha ao enviar arquivo', error)
        ack?.({ ok: false, error: errorText(error, 'Falha ao enviar arquivo') })
      }
    },
  )

  socket.on('load-earlier', async ({ contactId, before }: { contactId?: string; before?: number }, ack) => {
    try {
      if (!contactId || !before) throw new Error('Nada para carregar')
      const messages = await loadEarlier(contactId, before)
      socket.emit('thread', { contactId, messages })
      ack?.({ ok: true, messages })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao carregar') })
    }
  })

  socket.on(
    'blast',
    async ({ contactIds, template }: { contactIds?: string[]; template?: string }, ack) => {
      try {
        if (!contactIds?.length) throw new Error('Selecione pelo menos um contato')
        if (!template?.trim()) throw new Error('Digite a mensagem padrão')
        const result = await sendBlast(contactIds, template.trim())
        ack?.({ ok: true, ...result })
      } catch (error) {
        ack?.({ ok: false, error: errorText(error, 'Falha no disparo') })
      }
    },
  )

  socket.on(
    'command',
    async (
      payload: {
        type?: CommandAction
        contactIds?: string[]
        text?: string
        file?: CommandFile
        messageIds?: string[]
      },
      ack,
    ) => {
      try {
        if (!payload?.type) throw new Error('Escolha uma ação')
        const result = await runWhatsAppCommand({
          type: payload.type,
          contactIds: payload.contactIds ?? [],
          text: payload.text,
          file: payload.file,
          messageIds: payload.messageIds,
        })
        ack?.({ ok: true, ...result })
      } catch (error) {
        console.error('[zap] ação', error instanceof Error ? error.message : error)
        ack?.({ ok: false, error: errorText(error, 'Falha na ação') })
      }
    },
  )

  socket.on('decide', async (ctx: AgentContext, ack) => {
    const result = await decide(ctx || { text: '' })
    ack?.(result)
  })

  socket.on('profile', async ({ contactId }: { contactId?: string }, ack) => {
    try {
      if (!contactId) throw new Error('Conversa inválida')
      const info = await loadProfile(contactId)
      ack?.({ ok: true, ...info })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao abrir os dados') })
    }
  })

  socket.on('peek-thread', async ({ contactId }: { contactId?: string }, ack) => {
    if (!contactId) {
      ack?.({ ok: false, messages: [] })
      return
    }
    const messages = await loadThread(contactId)
    ack?.({ ok: true, messages })
  })

  socket.on('open-chat', async ({ contactId }: { contactId?: string }, ack) => {
    if (!contactId) {
      ack?.({ ok: false })
      return
    }
    const messages = await loadThread(contactId)
    socket.emit('thread', { contactId, messages })
    void markRead(contactId)
    watchChat(contactId)
    ack?.({ ok: true, messages })
  })

  socket.on('logout', async (ack) => {
    await logout()
    ack?.({ ok: true })
  })

  socket.on('typing', async ({ contactId, on }: { contactId?: string; on?: boolean }) => {
    if (!contactId) return
    try {
      await sendTyping(contactId, Boolean(on))
    } catch {
      /* ignore */
    }
  })

  socket.on('open-number', async ({ phone }: { phone?: string }, ack) => {
    try {
      const contact = await openNumber(phone || '')
      ack?.({ ok: true, contact })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao abrir o número') })
    }
  })

  socket.on('fetch-media', async ({ contactId, messageId }: { contactId?: string; messageId?: string }, ack) => {
    try {
      if (!contactId || !messageId) throw new Error('Mensagem inválida')
      const media = await fetchMessageMedia(contactId, messageId)
      ack?.({ ok: true, media })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao baixar') })
    }
  })

  socket.on('search-all', async ({ query }: { query?: string }, ack) => {
    try {
      const hits = await searchMessages(query || '')
      ack?.({ ok: true, hits })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha na pesquisa'), hits: [] })
    }
  })

  socket.on('export-full', async ({ contactId }: { contactId?: string }, ack) => {
    try {
      if (!contactId) throw new Error('Conversa inválida')
      const messages = await exportHistory(contactId)
      ack?.({ ok: true, messages })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao exportar') })
    }
  })

  socket.on('message-info', async ({ messageId }: { messageId?: string }, ack) => {
    try {
      if (!messageId) throw new Error('Mensagem inválida')
      ack?.({ ok: true, ...(await messageInfo(messageId)) })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao abrir as informações') })
    }
  })

  socket.on(
    'poll-vote',
    async ({ contactId, messageId, optionIds }: { contactId?: string; messageId?: string; optionIds?: number[] }, ack) => {
      try {
        if (!contactId || !messageId || !Array.isArray(optionIds)) throw new Error('Voto inválido')
        ack?.({ ok: true, poll: await votePoll(contactId, messageId, optionIds.map(Number)) })
      } catch (error) {
        ack?.({ ok: false, error: errorText(error, 'Não deu para votar') })
      }
    },
  )

  socket.on('report', async ({ contactId }: { contactId?: string }, ack) => {
    try {
      if (!contactId) throw new Error('Conversa inválida')
      ack?.({ ok: true, message: await reportChat(contactId) })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao denunciar') })
    }
  })

  socket.on('statuses', async (ack) => {
    try {
      ack?.({ ok: true, items: await listStatuses() })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha ao carregar status'), items: [] })
    }
  })

  socket.on(
    'post-status',
    async ({ text, file }: { text?: string; file?: CommandFile }, ack) => {
      try {
        ack?.({ ok: true, message: await postStatus(text || '', file) })
      } catch (error) {
        ack?.({ ok: false, error: errorText(error, 'Falha ao publicar') })
      }
    },
  )

  socket.on('call', async ({ contactId, video }: { contactId?: string; video?: boolean }, ack) => {
    try {
      if (!contactId) throw new Error('Escolha a conversa')
      ack?.({ ok: true, ...(await startCall(contactId, Boolean(video))) })
    } catch (error) {
      ack?.({ ok: false, error: errorText(error, 'Falha na chamada') })
    }
  })

  socket.on(
    'group-action',
    async (
      payload: {
        contactId?: string
        action?: 'add' | 'remove' | 'promote' | 'demote' | 'leave' | 'subject' | 'description' | 'picture' | 'invite'
        participantId?: string
        text?: string
        file?: CommandFile
      },
      ack,
    ) => {
      try {
        if (!payload?.contactId || !payload.action) throw new Error('Ação inválida')
        const message = await groupAction({
          contactId: payload.contactId,
          action: payload.action,
          participantId: payload.participantId,
          text: payload.text,
          file: payload.file,
        })
        ack?.({ ok: true, message })
      } catch (error) {
        ack?.({ ok: false, error: errorText(error, 'Falha no grupo') })
      }
    },
  )
})

waEvents.on('state', (state) => io.emit('state', state))
waEvents.on('chats', (chats) => io.emit('chats', chats))
waEvents.on('photos', (rows) => io.emit('photos', rows))
waEvents.on('message', (message) => io.emit('message', message))
waEvents.on('messages-sync', () => io.emit('snapshot', snapshot()))
waEvents.on('blast:progress', (progress) => io.emit('blast:progress', progress))

process.on('unhandledRejection', (error) => {
  console.warn('[zap] promise sem catch', error)
})

hydrateCache()

httpServer.listen(PORT, HOST, () => {
  console.log(`WhatsApp backend em http://${HOST}:${PORT}`)
  startWhatsApp()
})

async function shutdown() {
  await destroyWhatsApp()
  process.exit(0)
}

process.on('SIGINT', () => {
  void shutdown()
})
process.on('SIGTERM', () => {
  void shutdown()
})
