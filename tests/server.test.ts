import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'

test('agent talks to a plain-HTTP model (local/Ollama-style endpoint)', async () => {
  let seen: { url?: string; model?: string } = {}
  const fake = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      seen = { url: req.url, model: JSON.parse(body).model }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { content: '{"kind":"answer","text":"ok local"}' } }] }))
    })
  })
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve))
  const { port } = fake.address() as AddressInfo
  // Set before the agent reads .env, so these win over the real key.
  process.env.CHAT_API_KEY = 'local-test'
  process.env.CHAT_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.CHAT_MODEL = 'llama-test'
  try {
    const { decide } = await import('../server/agent.ts')
    const result = await decide({ text: 'que horas são?' })
    assert.deepEqual(result, { ok: true, decision: { kind: 'answer', text: 'ok local' } })
    assert.equal(seen.url, '/v1/chat/completions')
    assert.equal(seen.model, 'llama-test')
  } finally {
    fake.close()
  }
})

test('clearCache removes the saved chats file', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'zap-cache-'))
  const previous = process.cwd()
  process.chdir(dir)
  try {
    const { saveCache, loadCache, clearCache } = await import('../server/persist.ts')
    saveCache([{ id: '1@c.us', name: 'Teste' } as never], new Map([['1@c.us', [{ id: 'm1', text: 'oi' } as never]]]))
    assert.ok(existsSync(path.join(dir, 'data', 'cache.json')))
    assert.equal(loadCache()?.chats.length, 1)
    clearCache()
    assert.equal(existsSync(path.join(dir, 'data', 'cache.json')), false)
    assert.equal(loadCache(), null)
    clearCache() // no file: must not throw
  } finally {
    process.chdir(previous)
  }
})
