import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ASSISTANT_GUIDE, fold, looseContacts, mentionedContacts, messageMentions, parseCommand } from '../src/commands.ts'
import type { Contact } from '../src/types.ts'

function contact(id: string, name: string, isGroup = false, phone = ''): Contact {
  return { id, name, isGroup, phone, initials: '', color: '', lastSeen: '', lastAt: 0, unread: 0 } as Contact
}

const contacts = [
  contact('ana@c.us', 'Ana Souza', false, '+5511999990001'),
  contact('pedro@c.us', 'Pedro Lima', false, '+5511999990002'),
  contact('bruno@c.us', 'Bruno', false, '+5511999990003'),
  contact('andre@c.us', 'André Costa', false, '+5511999990004'),
  contact('jose@c.us', 'José', false, '+5511999990005'),
  contact('erica@c.us', 'Érica', false, '+5511999990006'),
  contact('mae@c.us', 'Mãe', false, '+5511999990007'),
  contact('familia@g.us', 'Família', true),
]

const parse = (input: string) => parseCommand(input, contacts)
const names = (ids: string[] = []) => ids.map((id) => contacts.find((item) => item.id === id)?.name)

test('fold keeps length and strips accents', () => {
  for (const sample of ['André', 'Conceição', 'ÉRICA', 'cadê 👍 já']) assert.equal(fold(sample).length, sample.length)
  assert.equal(fold('Cadê a Érica? Conceição'), 'cade a erica? conceicao')
})

test('every help-guide example is understood locally', () => {
  for (const section of ASSISTANT_GUIDE) {
    for (const example of section.examples) assert.ok(parse(example), `not parsed: ${example}`)
  }
})

test('send: short first names are recipients', () => {
  const parsed = parse('manda oi pra Ana')
  assert.equal(parsed?.type, 'text')
  assert.deepEqual(names(parsed?.contactIds), ['Ana Souza'])
  assert.equal(parsed?.detail, 'oi')
})

test('send: accented names are recipients', () => {
  assert.deepEqual(names(parse('manda oi pro André')?.contactIds), ['André Costa'])
  assert.deepEqual(names(parse('manda oi pra Érica')?.contactIds), ['Érica'])
  assert.deepEqual(names(parse('manda oi pro José')?.contactIds), ['José'])
  assert.deepEqual(names(parse('manda um beijo pra mãe')?.contactIds), ['Mãe'])
  assert.deepEqual(names(parse('manda oi pro andre')?.contactIds), ['André Costa'], 'typed without accent')
})

test('send: message text is kept word for word', () => {
  assert.equal(parse('manda pra Ana: chego no aeroporto de manhã')?.detail, 'chego no aeroporto de manhã')
  assert.equal(parse('manda bom dia com carinho pro Pedro')?.detail, 'bom dia com carinho')
  assert.equal(parse('manda pro Pedro que a reunião é às 10:30')?.detail, 'a reunião é às 10:30')
  assert.equal(parse('manda uma mensagem pra Ana dizendo que o pix caiu')?.detail, 'o pix caiu')
  assert.equal(parse('manda um abraço pra Ana')?.detail, 'um abraço')
})

test('send: a name inside the message is not a recipient', () => {
  const parsed = parse('manda pro Pedro que a Ana chegou')
  assert.deepEqual(names(parsed?.contactIds), ['Pedro Lima'])
  assert.equal(parsed?.detail, 'a Ana chegou')
})

test('send: no named recipient means the open chat (empty contactIds)', () => {
  const parsed = parse('manda que já estou chegando')
  assert.deepEqual(parsed?.contactIds, [])
  assert.equal(parsed?.detail, 'já estou chegando')
})

test('send to a phone number keeps the message', () => {
  const parsed = parse('fala com 11999998888 que chego no aeroporto')
  assert.equal(parsed?.phone, '5511999998888')
  assert.equal(parsed?.detail, 'chego no aeroporto')
  const sent = parse('manda oi tudo bem para 11 99999-8888')
  assert.equal(sent?.phone, '5511999998888')
  assert.equal(sent?.detail, 'oi tudo bem')
})

test('reply: keeps text and only targets an explicit person', () => {
  const open = parse('responde que a reunião é na sala do Bruno')
  assert.equal(open?.type, 'reply')
  assert.deepEqual(open?.contactIds, [])
  assert.equal(open?.detail, 'a reunião é na sala do Bruno')
  const named = parse('responde a Ana que chego às 8')
  assert.deepEqual(names(named?.contactIds), ['Ana Souza'])
  assert.equal(named?.detail, 'chego às 8')
})

test('edit keeps the new text', () => {
  assert.equal(parse('edita para bom dia')?.detail, 'bom dia')
  assert.equal(parse('edita a última para vou para casa')?.detail, 'vou para casa')
})

test('photo caption', () => {
  const parsed = parse('manda a foto pra Ana com a legenda feliz aniversário')
  assert.equal(parsed?.type, 'photo')
  assert.deepEqual(names(parsed?.contactIds), ['Ana Souza'])
  assert.equal(parsed?.detail, 'feliz aniversário')
})

test('accented commands match', () => {
  const find = parse('cadê o pix do Pedro')
  assert.equal(find?.assist, 'find')
  assert.equal(find?.detail, 'pix')
  assert.deepEqual(names(find?.contactIds), ['Pedro Lima'])
  assert.equal(parse('quem me mandou áudio hoje')?.assist, 'audio-today')
  assert.equal(parse('silencia esse grupo por uma semana')?.detail, '1w')
  assert.equal(parse('silencia por 8 horas')?.detail, '8h')
  assert.equal(parse('apaga só para mim')?.detail, 'me')
  assert.equal(parse('marca como não lida')?.type, 'unread')
})

test('search terms keep accented words whole', () => {
  assert.equal(parse('procura reunião do Pedro')?.detail, 'reunião')
})

test('open conversation by short or accented name', () => {
  assert.deepEqual(names(parse('abre a conversa da Ana')?.contactIds), ['Ana Souza'])
  assert.deepEqual(names(parse('conversa com André')?.contactIds), ['André Costa'])
})

test('mentions with accents and punctuation', () => {
  assert.deepEqual(names(messageMentions('@andre tudo bem?', contacts).contacts.map((item) => item.id)), ['André Costa'])
  assert.deepEqual(names(messageMentions('@Érica oi', contacts).contacts.map((item) => item.id)), ['Érica'])
  const ana = messageMentions('@Ana! bom dia', contacts)
  assert.deepEqual(names(ana.contacts.map((item) => item.id)), ['Ana Souza'])
  assert.equal(ana.text, '! bom dia')
  assert.deepEqual(messageMentions('@ninguem oi', contacts).unmatched, ['ninguem'])
})

test('name matching respects word edges', () => {
  assert.deepEqual(mentionedContacts('anamnese', contacts), [])
  assert.deepEqual(mentionedContacts('falar com André agora', contacts).map((item) => item.name), ['André Costa'])
  assert.deepEqual(looseContacts('oi Érica', contacts).map((item) => item.name), ['Érica'])
})
