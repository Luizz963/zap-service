(async function scrapeWhatsAppProfile() {
  var chatId = "__CHAT_ID__"

  function serialized(id) {
    if (!id) return ''
    if (typeof id === 'string') return id
    if (id._serialized) return String(id._serialized)
    if (id.$1) return String(id.$1)
    if (id.user && id.server) return String(id.user) + '@' + String(id.server)
    return ''
  }

  function phoneOf(id) {
    var text = serialized(id)
    var user = text.split('@')[0]
    if ((text.indexOf('@c.us') !== -1 || text.indexOf('@s.whatsapp.net') !== -1) && /^\d+$/.test(user)) {
      return '+' + user
    }
    try {
      var pn = window.require('WAWebLidMigrationUtils').toPn(id)
      var pnUser = serialized(pn).split('@')[0]
      if (/^\d{8,}$/.test(pnUser)) return '+' + pnUser
    } catch (ignored) {}
    return ''
  }

  function contactName(id, fallback) {
    try {
      var contact = window.require('WAWebCollections').Contact.get(id)
      if (contact) return String(contact.name || contact.pushname || contact.formattedName || fallback || '')
    } catch (ignored) {}
    return String(fallback || '')
  }

  function disappearingLabel(seconds) {
    var value = Number(seconds || 0)
    if (!value) return 'Desligadas'
    if (value === 86400) return '24 horas'
    if (value === 604800) return '7 dias'
    if (value === 7776000) return '90 dias'
    return 'Ligadas'
  }

  var empty = {
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

  var collections = window.require('WAWebCollections')
  var wid = window.require('WAWebWidFactory').createWid(chatId)
  var chat = null
  try {
    chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
  } catch (ignored) {}
  if (!chat) {
    try {
      chat = collections.Chat.get(wid) || collections.Chat.get(chatId)
    } catch (ignored) {}
  }
  if (!chat) return empty

  var isGroup = Boolean(chat.isGroup) || chatId.indexOf('@g.us') !== -1
  if (isGroup) {
    try {
      await window.require('WAWebGroupQueryJob').queryAndUpdateGroupMetadataById({ id: chatId })
    } catch (ignored) {}
  }

  var people = []
  if (isGroup && chat.groupMetadata && chat.groupMetadata.participants) {
    var raw = chat.groupMetadata.participants.getModelsArray
      ? chat.groupMetadata.participants.getModelsArray()
      : []
    for (var i = 0; i < raw.length; i++) {
      var person = raw[i]
      if (!person) continue
      var pid = serialized(person.id)
      if (!pid) continue
      people.push({
        id: pid,
        name: contactName(person.id, person.formattedName || person.pushname || person.name) || phoneOf(person.id) || 'Contato',
        phone: phoneOf(person.id),
        isAdmin: Boolean(person.isAdmin || person.isSuperAdmin),
      })
    }
    people.sort(function (a, b) {
      if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }

  var media = 0
  var links = 0
  var docs = 0
  var starred = 0
  var mediaItems = []
  var linkItems = []
  var docItems = []
  var starredItems = []
  try {
    var msgs = chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : []
    var linkPattern = /https?:\/\/[^\s]+|www\.[^\s]+/i
    for (var m = 0; m < msgs.length; m++) {
      var msg = msgs[m]
      if (!msg || msg.isNotification) continue
      var type = String(msg.type || '')
      var text = String(msg.body || msg.caption || msg.filename || '')
      var at = Number(msg.t || 0) * 1000
      var mid = serialized(msg.id) || chatId + '-' + String(m)
      if (type === 'image' || type === 'video' || type === 'sticker' || type === 'audio' || type === 'ptt') {
        media += 1
        if (mediaItems.length < 40) mediaItems.push({ id: mid, kind: type === 'ptt' ? 'audio' : type, text: text, at: at })
      } else if (type === 'document') {
        docs += 1
        if (docItems.length < 40) docItems.push({ id: mid, kind: 'document', text: text || 'Documento', at: at })
      }
      var linkMatch = text.match(linkPattern)
      if (linkMatch) {
        links += 1
        if (linkItems.length < 40) linkItems.push({ id: mid, kind: 'link', text: linkMatch[0], at: at })
      }
      if (msg.isStarred || msg.star) {
        starred += 1
        if (starredItems.length < 40) starredItems.push({ id: mid, kind: 'starred', text: text || type || 'Mensagem', at: at })
      }
    }
  } catch (ignored) {}

  var mute = Number(chat.muteExpiration || 0)
  var now = Date.now() / 1000
  var common = []
  if (!isGroup) {
    try {
      var contact = chat.contact || collections.Contact.get(wid) || collections.Contact.get(chatId)
      if (contact && !contact.commonGroups) {
        await window.require('WAWebFindCommonGroupsContactAction').findCommonGroups(contact)
      }
      var groups = contact && contact.commonGroups && contact.commonGroups.serialize ? contact.commonGroups.serialize() : []
      for (var g = 0; g < groups.length; g++) {
        var gid = serialized(groups[g] && (groups[g].id || groups[g]))
        if (!gid) continue
        var groupChat = collections.Chat.get(gid) || collections.Chat.get(groups[g].id)
        if (g < 12) {
          try {
            await window.require('WAWebGroupQueryJob').queryAndUpdateGroupMetadataById({ id: gid })
            groupChat = collections.Chat.get(gid) || groupChat
          } catch (ignored) {}
        }
        var names = []
        var meta = groupChat && groupChat.groupMetadata
        if (meta && meta.participants && meta.participants.getModelsArray) {
          var members = meta.participants.getModelsArray()
          for (var p = 0; p < members.length && names.length < 6; p++) {
            var label = contactName(members[p].id, members[p].formattedName || members[p].pushname)
            if (label) names.push(label)
          }
        }
        common.push({
          id: gid,
          name: String((groupChat && (groupChat.name || groupChat.formattedTitle)) || 'Grupo'),
          preview: names.join(', '),
        })
      }
    } catch (ignored) {}
  }

  var phone = ''
  if (!isGroup) {
    phone = phoneOf((chat.contact && (chat.contact.phoneNumber || chat.contact.id)) || wid)
  }

  return {
    description: String((chat.groupMetadata && chat.groupMetadata.desc) || ''),
    phone: phone,
    muted: mute === -1 || mute > now,
    disappearing: disappearingLabel(
      chat.ephemeralDuration || (chat.groupMetadata && chat.groupMetadata.ephemeralDuration) || 0,
    ),
    media: media,
    links: links,
    docs: docs,
    starred: starred,
    participants: people,
    commonGroups: common,
    mediaItems: mediaItems,
    linkItems: linkItems,
    docItems: docItems,
    starredItems: starredItems,
  }
})()
