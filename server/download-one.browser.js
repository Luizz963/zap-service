(async function downloadOne() {
  var chatId = "__CHAT_ID__"
  var messageId = "__MESSAGE_ID__"

  function serialized(id) {
    if (!id) return ''
    if (typeof id === 'string') return id
    if (id._serialized) return String(id._serialized)
    try {
      if (typeof id.toString === 'function') {
        var asText = id.toString()
        if (asText && asText !== '[object Object]') return String(asText)
      }
    } catch (ignored) {}
    return ''
  }

  function mediaKind(msg) {
    var type = String(msg && msg.type ? msg.type : '')
    var mime = String((msg && msg.mimetype) || (msg && msg.mediaData && msg.mediaData.mimetype) || '')
    if (type === 'sticker' || mime.indexOf('webp') !== -1) return 'sticker'
    if (type === 'video' || type === 'gif' || mime.indexOf('video/') === 0) return 'video'
    if (type === 'ptt' || type === 'audio' || mime.indexOf('audio/') === 0) return 'audio'
    return 'image'
  }

  function mimeFor(msg, kind) {
    var mime = String(msg.mimetype || (msg.mediaData && msg.mediaData.mimetype) || '')
    if (mime && mime !== 'application/octet-stream') return mime
    if (kind === 'sticker') return 'image/webp'
    if (kind === 'video') return 'video/mp4'
    if (kind === 'audio') return 'audio/ogg; codecs=opus'
    return 'image/jpeg'
  }

  var chat = null
  try {
    var store = window.require('WAWebCollections')
    var wid = window.require('WAWebWidFactory').createWid(chatId)
    chat = store.Chat.get(wid) || store.Chat.get(chatId)
  } catch (ignored) {}
  if (!chat || !chat.msgs || !chat.msgs.getModelsArray) return ''
  var msgs = chat.msgs.getModelsArray()
  var msg = null
  var keyMatch = /^(?:true|false)_[^_]+_([^_]+)/.exec(messageId)
  var key = keyMatch ? keyMatch[1] : messageId
  for (var i = 0; i < msgs.length; i++) {
    var current = msgs[i]
    if (!current || !current.id) continue
    if (serialized(current.id) === messageId || current.id.id === key) msg = current
  }
  if (!msg) return ''
  var kind = mediaKind(msg)
  var mime = mimeFor(msg, kind)
  var qpl = new Proxy({}, { get: function () { return function () { return qpl } } })
  var manager = window.require('WAWebDownloadManager').downloadManager
  var decrypted = await manager.downloadAndMaybeDecrypt({
    directPath: msg.directPath,
    encFilehash: msg.encFilehash,
    filehash: msg.filehash,
    mediaKey: msg.mediaKey,
    mediaKeyTimestamp: msg.mediaKeyTimestamp,
    type: kind === 'sticker' ? 'sticker' : kind === 'video' ? 'video' : 'image',
    mimetype: mime,
    signal: new AbortController().signal,
    downloadQpl: qpl,
  })
  if (!decrypted) return ''
  var buffer = decrypted
  if (typeof Blob !== 'undefined' && decrypted instanceof Blob) buffer = await decrypted.arrayBuffer()
  var data = ''
  try {
    data = window.WWebJS.arrayBufferToBase64(buffer)
  } catch (ignored) {
    data = await window.WWebJS.arrayBufferToBase64Async(buffer)
  }
  if (!data) return ''
  return 'data:' + mime + ';base64,' + data
})()
