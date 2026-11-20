(async function runChatAction() {
  var chatId = "__CHAT_ID__"
  var action = "__ACTION__"
  var seconds = __SECONDS__

  async function chat() {
    return await window.WWebJS.getChat(chatId, { getAsModel: false })
  }

  if (action === 'disappearing') {
    var current = await chat()
    var errors = []
    try {
      var cmd = window.require('WAWebCmd').Cmd
      if (typeof cmd.setEphemeral === 'function') {
        await cmd.setEphemeral(current, seconds)
        return true
      }
      errors.push('sem setEphemeral')
    } catch (error) {
      errors.push(error && error.message ? error.message : String(error))
    }
    var modules = ['WAWebDisappearingModeAction', 'WAWebEphemeralFields', 'WAWebSetEphemeralSettingAction']
    for (var i = 0; i < modules.length; i++) {
      try {
        var mod = window.require(modules[i])
        var fn = mod.setDisappearingMode || mod.setEphemeralFields || mod.setEphemeralSetting || mod.setEphemeral
        if (typeof fn === 'function') {
          await fn(current, seconds)
          return true
        }
      } catch (error) {
        errors.push(error && error.message ? error.message : String(error))
      }
    }
    throw new Error(errors.join(' | ') || 'Mensagens temporárias indisponíveis')
  }

  if (action === 'block' || action === 'unblock') {
    var contact = await window.require('WAWebCollections').Contact.find(chatId)
    var resolved = window
      .require('WAWebBlockContactUtils')
      .getContactToBlockOnlyUseIfNoAssociatedChat(contact, 'ChatListBlock')
    var blocker = window.require('WAWebBlockContactAction')
    if (action === 'block') await blocker.blockContact({ contact: resolved })
    else await blocker.unblockContact(resolved)
    return true
  }

  return false
})()
