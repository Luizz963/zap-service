(async function scrapeWhatsAppThread() {
  var chatId = "__CHAT_ID__"
  var beforeTs = __BEFORE_TS__
  var MAX_MEDIA = 12

  function serialized(id) {
    if (!id) return ''
    if (typeof id === 'string') return id
    if (id._serialized) return String(id._serialized)
    if (id.$1) return String(id.$1)
    if (id.user && id.server) return String(id.user) + '@' + String(id.server)
    return ''
  }

  /*__POLL_READER__*/

  function messageText(msg) {
    if (!msg) return ''
    var body = msg.body ? String(msg.body) : ''
    if (body.length > 64 && (body.indexOf('/9j/') === 0 || body.indexOf('iVBOR') === 0 || body.indexOf('UklGR') === 0 || body.indexOf('R0lGOD') === 0)) {
      body = ''
    }
    if (body) return body
    if (msg.caption) return String(msg.caption)
    // Messages without a body still need a readable line, or they'd vanish from the chat.
    var type = String(msg.type || '')
    if (type === 'poll_creation' && msg.pollName) return '📊 ' + String(msg.pollName)
    if (type === 'location') return '📍 ' + String(msg.loc || 'Localização')
    if (type === 'vcard' || type === 'multi_vcard') return '👤 ' + String(msg.vcardFormattedName || 'Contato')
    if (type === 'document') return String(msg.filename || 'Documento')
    if (type === 'revoked') return 'Mensagem apagada'
    return ''
  }

  function msgType(msg) {
    return String(msg && msg.type ? msg.type : 'chat')
  }

  function mediaKind(msg) {
    var type = msgType(msg)
    var mime = String(
      (msg && msg.mimetype) ||
        (msg && msg.mediaData && msg.mediaData.mimetype) ||
        '',
    )
    if (type === 'sticker' || msg.isSticker || mime.indexOf('webp') !== -1) return 'sticker'
    if (type === 'image' || mime.indexOf('image/') === 0) return 'image'
    if (type === 'video' || type === 'ptv' || type === 'gif' || mime.indexOf('video/') === 0) return 'video'
    if (type === 'ptt' || type === 'audio' || mime.indexOf('audio/') === 0) return 'audio'
    return 'text'
  }

  // Reactions live in their own store now (msg.reactions no longer exists):
  // Reactions.find(key) -> groups of { aggregateEmoji, hasReactionByMe, senders: [{ reactionText, senderUserJid, id: { fromMe } }] }
  async function reactionsOf(msg) {
    var out = []
    try {
      var store = window.require('WAWebCollections').Reactions
      var found = store && (await store.find(msg.id))
      var groups = found && found.reactions && found.reactions.serialize ? found.reactions.serialize() : []
      for (var r = 0; r < groups.length; r++) {
        var group = groups[r]
        var emoji = String(group.aggregateEmoji || group.id || '')
        if (!emoji) continue
        var senders = Array.isArray(group.senders) ? group.senders : []
        if (!senders.length) {
          out.push({ emoji: emoji, fromMe: Boolean(group.hasReactionByMe), author: '' })
          continue
        }
        for (var s = 0; s < senders.length; s++) {
          var sender = senders[s]
          out.push({
            emoji: String(sender.reactionText || emoji),
            fromMe: Boolean(sender.id && sender.id.fromMe),
            author: String(sender.senderUserJid || ''),
          })
        }
      }
    } catch (ignored) {}
    return out
  }

  function keep(msg) {
    if (!msg || msg.isNotification) return false
    var kind = mediaKind(msg)
    if (kind === 'sticker' || kind === 'image' || kind === 'audio' || kind === 'video') return true
    if (messageText(msg)) return true
    return false
  }

  function mimeFor(msg) {
    var kind = mediaKind(msg)
    var mime = String(msg.mimetype || (msg.mediaData && msg.mediaData.mimetype) || '')
    if (mime && mime !== 'application/octet-stream') return mime
    if (kind === 'sticker') return 'image/webp'
    if (kind === 'video') return 'video/mp4'
    if (kind === 'audio') return 'audio/ogg; codecs=opus'
    return 'image/jpeg'
  }

  async function blobToDataUrl(url) {
    try {
      var res = await fetch(url)
      var blob = await res.blob()
      return await new Promise(function (resolve) {
        var reader = new FileReader()
        reader.onloadend = function () {
          resolve(String(reader.result || ''))
        }
        reader.onerror = function () {
          resolve('')
        }
        reader.readAsDataURL(blob)
      })
    } catch (ignored) {
      return ''
    }
  }

  async function downloadMedia(msg) {
    var errors = []
    var mime = mimeFor(msg)
    var kind = mediaKind(msg)

    try {
      if (msg.mediaData && msg.mediaData.mediaBlob) {
        var blobObj = msg.mediaData.mediaBlob
        var blobUrl = ''
        if (typeof blobObj.url === 'function') blobUrl = blobObj.url()
        else if (blobObj._url) blobUrl = blobObj._url
        if (blobUrl) {
          var fromBlob = await blobToDataUrl(blobUrl)
          if (fromBlob.indexOf('data:') === 0) return fromBlob
        }
      }
    } catch (error) {
      errors.push('blob:' + (error && error.message ? error.message : error))
    }

    try {
      if (msg.mediaData && msg.mediaData.renderableUrl) {
        var fromUrl = await blobToDataUrl(msg.mediaData.renderableUrl)
        if (fromUrl.indexOf('data:') === 0) return fromUrl
      }
    } catch (error) {
      errors.push('url:' + (error && error.message ? error.message : error))
    }

    try {
      if (msg.mediaData && msg.mediaData.mediaStage === 'REUPLOADING') {
        throw new Error('REUPLOADING')
      }
      if (msg.mediaData && msg.mediaData.mediaStage && msg.mediaData.mediaStage !== 'RESOLVED' && typeof msg.downloadMedia === 'function') {
        await msg.downloadMedia({
          downloadEvenIfExpensive: true,
          rmrReason: 1,
        })
      }
      var qpl = new Proxy(
        {},
        {
          get: function () {
            return function () {
              return qpl
            }
          },
        },
      )
      var manager = window.require('WAWebDownloadManager').downloadManager
      var decryptOpts = {
        directPath: msg.directPath,
        encFilehash: msg.encFilehash,
        filehash: msg.filehash,
        mediaKey: msg.mediaKey,
        mediaKeyTimestamp: msg.mediaKeyTimestamp,
        type: mediaKind(msg) === 'sticker' ? 'sticker' : mediaKind(msg) === 'video' ? 'video' : msg.type,
        mimetype: mime,
        signal: new AbortController().signal,
        downloadQpl: qpl,
      }
      var decrypted
      try {
        decrypted = await manager.downloadAndMaybeDecrypt(decryptOpts)
      } catch (first) {
        if (kind !== 'image' && kind !== 'sticker') throw first
        decryptOpts.type = 'image'
        decryptOpts.mimetype = mime.indexOf('image/') === 0 ? mime : 'image/webp'
        decrypted = await manager.downloadAndMaybeDecrypt(decryptOpts)
      }
      if (!decrypted) throw new Error('decrypt-empty')
      var byteSize = decrypted.byteLength || decrypted.size || 0
      if ((kind === 'video' && byteSize > 5000000) || (kind === 'audio' && byteSize > 8000000)) {
        throw new Error('arquivo grande demais')
      }
      var buffer = decrypted
      if (typeof Blob !== 'undefined' && decrypted instanceof Blob) {
        buffer = await decrypted.arrayBuffer()
      }
      var data = ''
      try {
        data = window.WWebJS.arrayBufferToBase64(buffer)
      } catch (ignored) {
        data = await window.WWebJS.arrayBufferToBase64Async(buffer)
      }
      if (!data) throw new Error('b64-empty:' + typeof decrypted)
      return 'data:' + mime + ';base64,' + data
    } catch (error) {
      errors.push('decrypt:' + (error && error.message ? error.message : error))
    }

    throw new Error(errors.join(' | ') || 'fail')
  }

  var chat = null
  try {
    if (window.WWebJS && window.WWebJS.getChat) {
      chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
    }
  } catch (ignored) {}

  if (!chat) {
    try {
      var store = window.require('WAWebCollections')
      var wid = window.require('WAWebWidFactory').createWid(chatId)
      chat = store.Chat.get(wid) || store.Chat.get(chatId)
      if (!chat) {
        var found = await window.require('WAWebFindChatAction').findOrCreateLatestChat(wid)
        chat = found && found.chat
      }
    } catch (ignored) {}
  }

  if (!chat) return []

  var msgs = []
  try {
    msgs = (chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : []).filter(function (msg) {
      return msg && !msg.isNotification
    })
  } catch (ignored) {}

  try {
    var guard = 0
    while (guard < 8) {
      var kept = msgs.filter(function (msg) {
        return keep(msg) && (!beforeTs || Number(msg.t || 0) < beforeTs)
      })
      if (kept.length >= (beforeTs ? 30 : 40)) break
      var oldest = msgs.reduce(function (min, msg) {
        var stamp = Number(msg.t || 0)
        return stamp && stamp < min ? stamp : min
      }, Number.MAX_SAFE_INTEGER)
      var previous = msgs.length
      await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat: chat })
      var fresh = (chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : []).filter(function (msg) {
        return msg && !msg.isNotification
      })
      if (!fresh.length || fresh.length <= previous) break
      var nextOldest = fresh.reduce(function (min, msg) {
        var stamp = Number(msg.t || 0)
        return stamp && stamp < min ? stamp : min
      }, Number.MAX_SAFE_INTEGER)
      msgs = fresh
      if (nextOldest >= oldest) break
      guard += 1
    }
  } catch (ignored) {}

  try {
    if (chat.lastMessage && !msgs.some(function (msg) {
      return serialized(msg.id) === serialized(chat.lastMessage.id)
    })) {
      msgs.push(chat.lastMessage)
    }
  } catch (ignored) {}

  msgs.sort(function (a, b) {
    return Number(a.t || 0) - Number(b.t || 0)
  })
  if (beforeTs) msgs = msgs.filter(function (msg) { return Number(msg.t || 0) < beforeTs })
  if (msgs.length > 40) msgs = msgs.slice(msgs.length - 40)

  var imageLeft = MAX_MEDIA
  var audioLeft = 8
  var videoLeft = 4
  var packed = []
  for (var i = msgs.length - 1; i >= 0; i--) {
    var src = msgs[i]
    var kind = mediaKind(src)
    var wantMedia = false
    if ((kind === 'sticker' || kind === 'image') && imageLeft > 0) {
      wantMedia = true
      imageLeft -= 1
    } else if (kind === 'audio' && audioLeft > 0) {
      wantMedia = true
      audioLeft -= 1
    } else if (kind === 'video' && videoLeft > 0) {
      wantMedia = true
      videoLeft -= 1
    }
    packed.unshift({
      src: src,
      kind: kind,
      wantMedia: wantMedia,
    })
  }

  var messages = await Promise.all(
    packed.map(async function (item, index) {
      var msg = item.src
      var text = messageText(msg)
      var media = ''
      var mediaError = ''
      if (item.wantMedia) {
        try {
          media = await downloadMedia(msg)
        } catch (error) {
          mediaError = error && error.message ? String(error.message) : String(error)
        }
        if (!media && !mediaError) {
          mediaError =
            'stage=' +
            String((msg.mediaData && msg.mediaData.mediaStage) || 'none') +
            ' path=' +
            (msg.directPath ? 'yes' : 'no') +
            ' key=' +
            (msg.mediaKey ? 'yes' : 'no') +
            ' url=' +
            (msg.mediaData && msg.mediaData.renderableUrl ? 'yes' : 'no')
        }
      }
      if (!text && !media && item.kind === 'text') return null
      var author = msg.author || (msg.id && msg.id.participant) || null
      var authorName = String(msg.notifyName || '')
      try {
        var authorContact = author && window.require('WAWebCollections').Contact.get(author)
        if (authorContact) {
          authorName = String(authorContact.name || authorContact.pushname || authorName)
        }
      } catch (ignored) {}
      return {
        id: serialized(msg.id) || chatId + '-' + String(msg.t || index),
        from: chatId,
        body: text,
        fromMe: Boolean(msg.id && msg.id.fromMe) || Boolean(msg.fromMe),
        timestamp: Number(msg.t || 0),
        kind: item.kind,
        media: media,
        mediaError: mediaError,
        authorId: serialized(author),
        authorName: authorName,
        duration: (function () {
          var seconds = Number(msg.duration || (msg.mediaData && msg.mediaData.duration) || 0)
          if (!seconds) return 0
          if (seconds > 10000) seconds = Math.round(seconds / 1000)
          return Math.round(seconds)
        })(),
        quote: msg.quotedMsg
          ? {
              id: serialized(msg.quotedMsg.id),
              text: String(msg.quotedMsg.body || msg.quotedMsg.caption || '').slice(0, 120),
            }
          : undefined,
        ack: Number(msg.ack || 0),
        starred: Boolean(msg.isStarred || msg.star),
        pinned: Boolean(msg.pin || msg.isPinned),
        gif: msgType(msg) === 'gif' || Boolean(msg.isGif),
        reactions: await reactionsOf(msg),
        poll: await pollOf(msg),
        filename: String(msg.filename || ''),
      }
    }),
  )

  var result = []
  for (var j = 0; j < messages.length; j++) {
    if (messages[j]) result.push(messages[j])
  }
  return result
})()
