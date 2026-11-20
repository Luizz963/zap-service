import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import * as wa from '../server/fake-whatsapp.ts'
import type { ChatMessage } from '../server/types.ts'

const byName = (name: string) => {
  const chat = wa.listChats().find((item) => item.name === name)
  assert.ok(chat, `chat ${name} exists`)
  return chat
}
const last = (id: string) => wa.listMessages(id).at(-1)!
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

before(async () => {
  await wa.startWhatsApp()
})
after(async () => {
  await wa.destroyWhatsApp()
})

test('starts ready with invented chats, never the real account', () => {
  assert.equal(wa.getState().status, 'ready')
  assert.equal(wa.getState().me?.name, 'Modo teste')
  assert.ok(wa.listChats().length >= 13)
  assert.ok(wa.listPhotos().length >= 13)
  assert.equal(byName('Condomínio Jardim').archived, true)
})

test('send: ticks go sent → delivered → read, and the person answers', async () => {
  const ana = byName('Ana Souza')
  const sent = await wa.sendText(ana.id, 'oi, tudo bem?')
  assert.equal(sent?.status, 'sent')
  await wait(4200)
  const mine = wa.listMessages(ana.id).find((item) => item.id === sent?.id)
  assert.equal(mine?.status, 'read')
  const reply = last(ana.id)
  assert.equal(reply.fromMe, false)
  assert.ok(reply.text.length > 0)
})

test('an empty message is never sent, and a 1-person send is not marked "via disparo"', async () => {
  const andre = byName('André Costa')
  const before = wa.listMessages(andre.id).length
  await assert.rejects(wa.sendText(andre.id, '   '), /vazia/)
  const result = await wa.runWhatsAppCommand({ type: 'text', contactIds: [andre.id], text: '' })
  assert.equal('failed' in result ? result.failed : 0, 1, 'the empty send fails instead of going out')
  assert.equal(wa.listMessages(andre.id).length, before, 'no blank bubble')
  await wa.runWhatsAppCommand({ type: 'text', contactIds: [andre.id], text: 'oi André' })
  assert.equal(wa.listMessages(andre.id).find((item) => item.text === 'oi André')?.viaBlast, false)
})

test('reply, react, edit and delete work on your messages', async () => {
  const pedro = byName('Pedro Lima')
  const replied = await wa.runWhatsAppCommand({ type: 'reply', contactIds: [pedro.id], text: 'Recebi' })
  assert.equal('message' in replied ? replied.message : '', 'Resposta enviada.')
  const answer = last(pedro.id)
  assert.ok(answer.quote, 'reply quotes the last message')

  await wa.runWhatsAppCommand({ type: 'react', contactIds: [pedro.id], text: '❤️' })
  assert.deepEqual(last(pedro.id).reactions?.map((item) => item.emoji), ['❤️'])

  await wa.runWhatsAppCommand({ type: 'edit', contactIds: [pedro.id], text: 'Recebi, valeu!' })
  assert.equal(wa.listMessages(pedro.id).find((item) => item.id === answer.id)?.text, 'Recebi, valeu!')

  const removed = await wa.runWhatsAppCommand({ type: 'delete', contactIds: [pedro.id], text: 'everyone' })
  assert.ok('removedIds' in removed && removed.removedIds?.includes(answer.id))
  assert.equal(wa.listMessages(pedro.id).some((item) => item.id === answer.id), false)
})

test('polls: you vote, change your vote, and remove it', async () => {
  const familia = byName('Família')
  const poll = wa.listMessages(familia.id).find((item) => item.poll) as ChatMessage
  assert.equal(poll.poll?.voters, 3)
  const voted = await wa.votePoll(familia.id, poll.id, [2])
  assert.equal(voted.voters, 4)
  assert.equal(voted.options.find((option) => option.name === 'Lasanha')?.mine, true)
  const removed = await wa.votePoll(familia.id, poll.id, [])
  assert.equal(removed.voters, 3)
})

test('groups: only admins can change them (like the real WhatsApp)', async () => {
  const vagas = byName('Vagas T.I. - Todos os Estados')
  await assert.rejects(wa.groupAction({ contactId: vagas.id, action: 'subject', text: 'Outro nome' }), /só os admins/)
  assert.equal(byName('Vagas T.I. - Todos os Estados').id, vagas.id, 'name unchanged')

  const trabalho = byName('Trabalho')
  assert.equal(await wa.groupAction({ contactId: trabalho.id, action: 'subject', text: 'Trabalho 2' }), 'Nome do grupo atualizado.')
  await wait(150)
  assert.equal(wa.listChats().find((item) => item.id === trabalho.id)?.name, 'Trabalho 2')
  await assert.rejects(wa.groupAction({ contactId: byName('Ana Souza').id, action: 'subject', text: 'x' }), /só funciona em grupo/)
})

test('archive, mute, favorite and block', async () => {
  const bruno = byName('Bruno')
  await wa.runWhatsAppCommand({ type: 'archive', contactIds: [bruno.id] })
  await wa.runWhatsAppCommand({ type: 'mute', contactIds: [bruno.id], text: '8h' })
  await wait(150)
  const after = wa.listChats().find((item) => item.id === bruno.id)!
  assert.equal(after.archived, true)
  assert.equal(after.muted, true)

  const jose = byName('José')
  await wa.runWhatsAppCommand({ type: 'block', contactIds: [jose.id] })
  await assert.rejects(wa.sendText(jose.id, 'oi'), /bloqueou/)
  await wa.runWhatsAppCommand({ type: 'unblock', contactIds: [jose.id] })
})

test('load earlier, profile, search, statuses and numbers', async () => {
  const bruno = byName('Bruno')
  const before = wa.listMessages(bruno.id).length
  const more = await wa.loadEarlier(bruno.id, wa.listMessages(bruno.id)[0]!.at)
  assert.ok(more.length > before, 'older messages appear')

  const profile = await wa.loadProfile(byName('Família').id)
  assert.equal(profile.participants.length, 4)
  assert.ok(profile.participants.some((person) => person.name === 'Você' && person.isAdmin))

  assert.ok((await wa.searchMessages('pix')).length > 0)
  assert.equal((await wa.listStatuses()).length, 3)
  await assert.rejects(wa.openNumber('11 98888-0000'), /não está no WhatsApp/)
  assert.equal((await wa.openNumber('11 98888-1234')).name, '+11988881234')
})
