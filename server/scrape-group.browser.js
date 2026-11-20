(async function scrapeWhatsAppGroup() {
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
      var pnText = serialized(pn)
      var pnUser = pnText.split('@')[0]
      if (/^\d{8,}$/.test(pnUser)) return '+' + pnUser
    } catch (ignored) {}
    return ''
  }

  function contactName(id, fallback) {
    try {
      var contact = window.require('WAWebCollections').Contact.get(id)
      if (contact) {
        return String(contact.name || contact.pushname || contact.formattedName || fallback || '')
      }
    } catch (ignored) {}
    return String(fallback || '')
  }

  try {
    await window.require('WAWebGroupQueryJob').queryAndUpdateGroupMetadataById({ id: chatId })
  } catch (ignored) {}

  var chat = null
  try {
    chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
  } catch (ignored) {}
  if (!chat) {
    try {
      var store = window.require('WAWebCollections')
      var wid = window.require('WAWebWidFactory').createWid(chatId)
      chat = store.Chat.get(wid) || store.Chat.get(chatId)
    } catch (ignored) {}
  }
  if (!chat || !chat.groupMetadata) return { description: '', participants: [] }

  var raw = []
  try {
    var participants = chat.groupMetadata.participants
    raw = participants && participants.getModelsArray ? participants.getModelsArray() : participants || []
  } catch (ignored) {}

  var people = []
  for (var i = 0; i < raw.length; i++) {
    var person = raw[i]
    if (!person) continue
    var id = serialized(person.id)
    if (!id) continue
    var name = contactName(person.id, person.formattedName || person.pushname || person.name)
    people.push({
      id: id,
      name: name || phoneOf(person.id) || 'Contato',
      phone: phoneOf(person.id),
      isAdmin: Boolean(person.isAdmin || person.isSuperAdmin),
    })
  }

  people.sort(function (a, b) {
    if (a.isAdmin !== b.isAdmin) return a.isAdmin ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return {
    description: String(chat.groupMetadata.desc || ''),
    participants: people,
  }
})()
