import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from '../src/commands.ts'
import type { Contact } from '../src/types.ts'

function contact(id: string, name: string, isGroup = false): Contact {
  return { id, name, isGroup, phone: '', initials: '', color: '', lastSeen: '', lastAt: 0, unread: 0 } as Contact
}
const contacts = [contact('ana', 'Ana Souza'), contact('pedro', 'Pedro Lima'), contact('trab', 'Trabalho', true), contact('fam', 'Família', true)]
const parse = (input: string) => parseCommand(input, contacts)
const kind = (input: string) => {
  const parsed = parse(input)
  return parsed ? parsed.assist || parsed.local || parsed.type : null
}

test('formal and informal forms mean the same command', () => {
  const pairs: [string, string, string][] = [
    ['mude o nome para Novo', 'muda o nome para Novo', 'group-rename'],
    ['mande oi pra Ana', 'manda oi pra Ana', 'text'],
    ['envie oi pra Ana', 'envia oi pra Ana', 'text'],
    ['responda que chego às 8', 'responde que chego às 8', 'reply'],
    ['apague a última', 'apaga a última', 'delete'],
    ['edite para bom dia', 'edita para bom dia', 'edit'],
    ['reaja com 👍', 'reage com 👍', 'react'],
    ['silencie por 8 horas', 'silencia por 8 horas', 'mute'],
    ['dessilencie', 'dessilencia', 'unmute'],
    ['fixe a última', 'fixa a última', 'pinmsg'],
    ['adicione o Pedro', 'adiciona o Pedro', 'group-add'],
    ['remova o Pedro do grupo', 'remove o Pedro do grupo', 'group-remove'],
    ['promova o Pedro', 'promove o Pedro', 'group-promote'],
    ['rebaixe o Pedro', 'rebaixa o Pedro', 'group-demote'],
    ['abra a conversa da Ana', 'abre a conversa da Ana', 'open'],
    ['procure o pix', 'procura o pix', 'find'],
    ['marque como lida', 'marca como lida', 'mark-read'],
    ['gere o link', 'gera o link', 'group-link'],
    ['saia do grupo', 'sai do grupo', 'group-leave'],
    ['mude a foto do grupo', 'muda a foto do grupo', 'group-picture'],
    ['mude a descrição para avisos', 'muda a descrição para avisos', 'group-description'],
    ['resuma a conversa', 'resume a conversa', 'summary'],
    ['trave o app 1234', 'trava o app 1234', 'lock-app'],
    ['limpe a conversa', 'limpar conversa', 'clear'],
    ['tire dos favoritos', 'tira dos favoritos', 'unpin'],
    ['encaminhe pra Ana', 'encaminha pra Ana', 'forward'],
    ['poste um status: bom dia', 'posta um status: bom dia', 'status-post'],
  ]
  for (const [formal, informal, expected] of pairs) {
    assert.equal(kind(formal), expected, formal)
    assert.equal(kind(informal), expected, informal)
  }
})

test('the reported message: "mude o nome do grupo trabalho para Grupo Novo"', () => {
  const parsed = parse('mude o nome do grupo trabalho para Grupo Novo')
  assert.equal(parsed?.assist, 'group-rename')
  assert.deepEqual(parsed?.contactIds, ['trab'])
  assert.equal(parsed?.detail, 'Grupo Novo')
})

test('other ways to rename', () => {
  for (const input of ['altere o nome para Novo', 'troque o nome para Novo', 'coloque o nome Novo', 'renomeie para Novo', 'mudar o nome para Novo']) {
    assert.equal(kind(input), 'group-rename', input)
  }
})

test('details are extracted from formal forms too', () => {
  assert.equal(parse('mande oi pra Ana')?.detail, 'oi')
  assert.deepEqual(parse('mande oi pra Ana')?.contactIds, ['ana'])
  assert.equal(parse('responda que chego às 8')?.detail, 'chego às 8')
  assert.equal(parse('edite para bom dia')?.detail, 'bom dia')
  assert.equal(parse('mude a descrição para avisos da semana')?.detail, 'avisos da semana')
  assert.equal(parse('poste um status: bom dia')?.detail, 'bom dia')
  assert.equal(parse('resuma a conversa')?.detail, '', 'the verb is not taken for a name')
  assert.equal(parse('procure o pix do Pedro')?.detail, 'pix')
})

test('create a group', () => {
  const parsed = parse('crie um grupo Viagem com a Ana e o Pedro')
  assert.equal(parsed?.assist, 'group-create')
  assert.equal(parsed?.detail, 'Viagem')
  assert.deepEqual(parsed?.contactIds.sort(), ['ana', 'pedro'])
  assert.equal(parse('cria um grupo chamado Futebol com o Pedro')?.detail, 'Futebol')
  assert.equal(kind('abra o grupo Família'), 'open', 'opening is not creating')
})

test('"coloque" adds a person, but "coloque o nome" renames', () => {
  assert.equal(kind('coloque o Pedro no grupo'), 'group-add')
  assert.equal(kind('coloque o nome Viagem'), 'group-rename')
  assert.equal(parse('coloque o nome Viagem de Férias')?.detail, 'Viagem de Férias')
})
