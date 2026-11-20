import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from '../src/commands.ts'
import type { Contact } from '../src/types.ts'

function contact(id: string, name: string, isGroup = false): Contact {
  return { id, name, isGroup, phone: '', initials: '', color: '', lastSeen: '', lastAt: 0, unread: 0 } as Contact
}

const contacts = [
  contact('teste@g.us', 'teste', true),
  contact('familia@g.us', 'Família', true),
  contact('grupo@g.us', 'Grupo da Família Silva', true),
  contact('vagas@g.us', 'Vagas T.I. - Todos os Estados', true),
  contact('ajuda@g.us', 'Ajuda Mútua', true),
  contact('bruno@c.us', 'Bruno'),
  contact('ana@c.us', 'Ana Souza'),
]
const parse = (input: string) => parseCommand(input, contacts)

test('rename inside a group: the new name never picks another group', () => {
  // The reported bug: words of the NEW name matched other groups, which got renamed instead.
  for (const [input, name] of [
    ['muda o nome para Grupo Teste 2', 'Grupo Teste 2'],
    ['muda o nome para Família 2', 'Família 2'],
    ['muda o nome para Vagas novas', 'Vagas novas'],
    ['muda o nome para teste', 'teste'],
    ['renomeia para Ajuda Mútua', 'Ajuda Mútua'],
    ['muda o nome para Busca de vagas', 'Busca de vagas'],
  ]) {
    const parsed = parse(input)
    assert.equal(parsed?.assist, 'group-rename', input)
    assert.deepEqual(parsed?.contactIds, [], `${input} → must use the open group`)
    assert.equal(parsed?.detail, name, input)
  }
})

test('rename can still name the group explicitly, by full name, before "para"', () => {
  const parsed = parse('muda o nome do grupo Família para Viagem para Bahia')
  assert.deepEqual(parsed?.contactIds, ['familia@g.us'])
  assert.equal(parsed?.detail, 'Viagem para Bahia', 'splits at the FIRST para')
})

test('a group is never matched by its first word only', () => {
  assert.deepEqual(parse('muda o nome do grupo vagas para X')?.contactIds, [])
  assert.deepEqual(parse('gera o link do grupo')?.contactIds, [])
  assert.deepEqual(parse('sai do grupo')?.contactIds, [])
})

test('description text never picks a group', () => {
  const parsed = parse('descrição do grupo: avisos da Família e do teste')
  assert.equal(parsed?.assist, 'group-description')
  assert.deepEqual(parsed?.contactIds, [])
  assert.equal(parsed?.detail, 'avisos da Família e do teste')
  assert.deepEqual(parse('teste descrição do grupo: oi')?.contactIds, ['teste@g.us'])
})

test('member commands: person by name, group only by full name', () => {
  const add = parse('adiciona o Bruno')
  assert.equal(add?.assist, 'group-add')
  assert.deepEqual(add?.contactIds, ['bruno@c.us'])
  assert.equal(add?.detail, 'bruno@c.us')
  const remove = parse('remove o Bruno do grupo Família')
  assert.deepEqual(remove?.contactIds, ['familia@g.us', 'bruno@c.us'])
})
