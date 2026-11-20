  // Injected into other page scripts (scrape-thread, poll jobs). Defines pollOf(msg).
  // Reads a poll message's question, options and current votes from WhatsApp Web.
  // Votes live in the WAWebPollsVotesSchema table, one row per voter (latest wins), with the
  // picked options as bytes of option localIds — the same way whatsapp-web.js reads them.
  async function pollOf(msg) {
    if (!msg || msg.type !== 'poll_creation') return undefined
    var options = (msg.pollOptions || []).map(function (option) {
      return { id: Number(option.localId), name: String(option.name || ''), votes: 0, voters: [], mine: false }
    })

    var meIds = []
    try {
      var MeUser = window.require('WAWebUserPrefsMeUser')
      var phoneId = MeUser.getMeUser && MeUser.getMeUser()
      var lidId = MeUser.getMaybeMeLidUser && MeUser.getMaybeMeLidUser()
      if (phoneId) meIds.push(String(phoneId.toString()))
      if (lidId) meIds.push(String(lidId.toString()))
    } catch (ignored) {}

    function jidText(value) {
      if (!value) return ''
      if (typeof value === 'string') return value
      try { return String(value._serialized || value.toString()) } catch (ignored) { return '' }
    }

    function nameOf(jid) {
      try {
        var Contacts = window.require('WAWebCollections').Contact
        var contact = Contacts.get(jid)
        if (!contact) contact = Contacts.get(window.require('WAWebWidFactory').createWid(jid))
        if (contact) return String(contact.name || contact.pushname || contact.verifiedName || contact.formattedName || jid.split('@')[0])
      } catch (ignored) {}
      return jid.split('@')[0]
    }

    var rows = []
    try {
      rows = await window.require('WAWebPollsVotesSchema').getTable().equals(['parentMsgKey'], msg.id.toString())
    } catch (ignored) {}

    var latest = {}
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r]
      var who = jidText(row.sender)
      if (!who) continue
      var at = Number(row.senderTimestampMs || 0)
      if (latest[who] && latest[who].at > at) continue
      var picked = []
      try { picked = Array.from(new Uint8Array(row.selectedOptionLocalIds || [])) } catch (ignored) {}
      latest[who] = { at: at, picked: picked }
    }

    var voters = 0
    Object.keys(latest).forEach(function (who) {
      var picked = latest[who].picked
      if (!picked.length) return
      voters += 1
      var mine = meIds.indexOf(who) !== -1
      var name = mine ? 'Você' : nameOf(who)
      for (var p = 0; p < picked.length; p++) {
        for (var o = 0; o < options.length; o++) {
          if (options[o].id !== Number(picked[p])) continue
          options[o].votes += 1
          options[o].voters.push(name)
          if (mine) options[o].mine = true
        }
      }
    })

    return {
      name: String(msg.pollName || ''),
      // WhatsApp stores 1 for single choice and 0 for "any number of options".
      multi: Number(msg.pollSelectableOptionsCount || 0) !== 1,
      options: options,
      voters: voters,
    }
  }
