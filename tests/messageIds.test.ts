import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isFullMessageId, messageKey, sameMessageId, serializeMessageId } from '../src/messageIds.ts'

const GROUP = '120363000000000017@g.us'
const ME = '25600000000097@lid'
const oi = `true_${GROUP}_3EB0B86DB7B54D686A69_${ME}`
const tudoCerto = `true_${GROUP}_3EB0B1F2E8B7D109AB14_${ME}`

test('messageKey takes the middle part, not the sender at the end', () => {
  assert.equal(messageKey(oi), '3EB0B86DB7B54D686A69')
  assert.equal(messageKey('true_5511999990001@c.us_3EB0AAAA1111'), '3EB0AAAA1111')
  assert.equal(messageKey('3EB0B86DB7B54D686A69'), '3EB0B86DB7B54D686A69')
})

test('two different messages from me in a group are NOT the same message', () => {
  // This was the bug: both ended in the same sender id, so "tudo certo" overwrote "oi".
  assert.equal(sameMessageId(oi, tudoCerto), false)
})

test('short and full forms of one message match', () => {
  assert.equal(sameMessageId(oi, '3EB0B86DB7B54D686A69'), true)
})

test('serializeMessageId works without _serialized (current WhatsApp Web)', () => {
  assert.equal(serializeMessageId({ fromMe: true, remote: GROUP, id: '3EB0B86DB7B54D686A69', participant: { _serialized: ME }, $1: oi }), oi)
  assert.equal(
    serializeMessageId({ fromMe: true, remote: GROUP, id: '3EB0B86DB7B54D686A69', participant: { user: '25600000000097', server: 'lid' } }),
    oi,
    'built from parts when $1 is missing too',
  )
  assert.equal(serializeMessageId({ fromMe: false, remote: { _serialized: '5511999990001@c.us' }, id: 'ABC123456789' }), 'false_5511999990001@c.us_ABC123456789')
  assert.equal(serializeMessageId({ _serialized: 'x_y_z' }), 'x_y_z')
  assert.equal(serializeMessageId(undefined), '')
})

test('isFullMessageId', () => {
  assert.equal(isFullMessageId(oi), true)
  assert.equal(isFullMessageId('3EB0B86DB7B54D686A69'), false)
  assert.equal(isFullMessageId('1731700000000'), false)
})
