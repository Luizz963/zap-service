(function scrapeWhatsAppChats() {
  function serialized(id) {
    if (!id) return ''
    if (typeof id === 'string') return id
    if (id._serialized) return String(id._serialized)
    if (id.$1) return String(id.$1)
    if (id.user && id.server) return String(id.user) + '@' + String(id.server)
    try {
      if (typeof id.toString === 'function') {
        var asText = id.toString()
        if (asText && asText !== '[object Object]') return String(asText)
      }
    } catch (ignored) {}
    return ''
  }

  function chatCollection() {
    try {
      if (window.Store && window.Store.Chat) return window.Store.Chat
    } catch (ignored) {}
    try {
      var collections = window.require('WAWebCollections')
      if (collections && collections.Chat) return collections.Chat
    } catch (ignored) {}
    return null
  }

  function messageText(msg) {
    if (!msg) return ''
    var body = msg.body ? String(msg.body) : ''
    if (body.length > 64 && (body.indexOf('/9j/') === 0 || body.indexOf('iVBOR') === 0 || body.indexOf('UklGR') === 0 || body.indexOf('R0lGOD') === 0)) {
      body = ''
    }
    if (body) return body
    if (msg.caption) return String(msg.caption)
    var type = String(msg.type || '')
    if (type === 'image') return 'Foto'
    if (type === 'video') return 'Vídeo'
    if (type === 'ptt' || type === 'audio') return 'Áudio'
    if (type === 'sticker') return 'Figurinha'
    if (type === 'document') return 'Documento'
    return ''
  }

  function lastMessageOf(chat) {
    try {
      if (chat.msgs && typeof chat.msgs.getModelsArray === 'function') {
        var arr = chat.msgs.getModelsArray() || []
        if (arr.length) return arr[arr.length - 1]
      }
    } catch (ignored) {}
    return chat.lastMessage || chat.previewMessage || null
  }

  function phoneLike(value) {
    return /^\+?\d[\d\s().-]{6,}$/.test(String(value || '').trim())
  }

  function personName(contact) {
    var saved = String(contact.name || '').trim()
    if (saved && !phoneLike(saved)) return saved
    var verified = String(contact.verifiedName || '').trim()
    if (verified && !phoneLike(verified)) return verified
    var push = String(contact.pushname || '').trim()
    if (push && !phoneLike(push)) return push
    var short = String(contact.shortName || '').trim()
    if (short && !phoneLike(short)) return short
    return ''
  }

  function phoneOf(chat, id) {
    var contact = chat.contact || {}
    var pn = serialized(contact.phoneNumber || contact.userid)
    if (pn.indexOf('@') !== -1) pn = pn.split('@')[0]
    if (/^\d{8,}$/.test(pn)) return pn
    if (String(id).indexOf('@c.us') !== -1 || String(id).indexOf('@s.whatsapp.net') !== -1) {
      var user = String(id).split('@')[0]
      if (/^\d+$/.test(user)) return user
    }
    return ''
  }

  var collection = chatCollection()
  if (!collection || typeof collection.getModelsArray !== 'function') {
    return []
  }

  var models = collection.getModelsArray() || []
  var chats = []
  for (var i = 0; i < models.length; i++) {
    var chat = models[i]
    if (!chat) continue
    var id = serialized(chat.id)
    if (!id) continue
    var contact = chat.contact || {}
    var last = lastMessageOf(chat)
    var phone = phoneOf(chat, id)
    var mute = Number(chat.muteExpiration || 0)
    var now = Date.now() / 1000
    var isGroup = Boolean(chat.isGroup) || id.indexOf('@g.us') !== -1
    var saved = personName(contact)
    chats.push({
      id: id,
      name: isGroup
        ? String(chat.formattedTitle || chat.name || '')
        : saved || String(chat.formattedTitle || chat.name || contact.formattedName || ''),
      phone: phone,
      isGroup: isGroup,
      timestamp: Number((last && last.t) || chat.t || chat.timestamp || 0),
      lastBody: messageText(last),
      lastFromMe: Boolean(last && last.id && last.id.fromMe),
      lastId: serialized(last && last.id),
      unread: Number(chat.unreadCount || 0),
      muted: mute === -1 || mute > now,
      pinned: Boolean(chat.pin),
      archived: Boolean(chat.archive),
    })
  }
  return chats
})()
