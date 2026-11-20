(async function scrapeWhatsAppPhotos() {
  var ids = __IDS__
  var cachedOnly = __CACHED__

  function serialized(id) {
    if (!id) return ''
    if (typeof id === 'string') return id
    if (id._serialized) return String(id._serialized)
    if (id.user && id.server) return String(id.user) + '@' + String(id.server)
    return ''
  }

  function thumbUrl(thumb) {
    if (!thumb) return ''
    return String(thumb.img || thumb.imgFull || thumb.eurl || '')
  }

  async function lookup(id) {
    var collections = window.require('WAWebCollections')
    var wid = window.require('WAWebWidFactory').createWid(id)
    var thumb = null
    try {
      thumb = collections.ProfilePicThumb.get(wid) || collections.ProfilePicThumb.get(id)
    } catch (ignored) {}
    if (!thumbUrl(thumb)) {
      try {
        var chat = collections.Chat.get(wid) || collections.Chat.get(id)
        if (chat && chat.contact && chat.contact.profilePicThumb) thumb = chat.contact.profilePicThumb
      } catch (ignored) {}
    }
    if (!thumbUrl(thumb) && !cachedOnly) {
      try {
        thumb = await collections.ProfilePicThumb.find(wid)
      } catch (ignored) {}
    }
    if (!thumbUrl(thumb) && !cachedOnly) {
      try {
        var fullChat = await window.WWebJS.getChat(id, { getAsModel: false })
        if (fullChat) {
          thumb = await window
            .require('WAWebContactProfilePicThumbBridge')
            .requestProfilePicFromServer(fullChat)
        }
      } catch (ignored) {}
    }
    return thumbUrl(thumb)
  }

  async function toSquare(url) {
    if (!url) return ''
    if (url.indexOf('data:image/') === 0) return url
    var response = await fetch(url)
    if (!response.ok) return ''
    var blob = await response.blob()
    var bitmap = await createImageBitmap(blob)
    var size = 64
    var canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    var ctx = canvas.getContext('2d')
    var scale = Math.max(size / bitmap.width, size / bitmap.height)
    var width = bitmap.width * scale
    var height = bitmap.height * scale
    ctx.drawImage(bitmap, (size - width) / 2, (size - height) / 2, width, height)
    bitmap.close()
    return canvas.toDataURL('image/jpeg', 0.72)
  }

  var rows = []
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i] || '')
    if (!id) continue
    try {
      var url = await lookup(id)
      var photo = url ? await toSquare(url) : ''
      if (photo) rows.push({ id: serialized(id) || id, photo: photo })
    } catch (ignored) {}
  }
  return rows
})()
