import type { ChatMessage } from './types'

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function chatExportHtml(name: string, rows: ChatMessage[]) {
  const body = rows
    .map((message) => {
      const who = message.fromMe ? 'Eu' : message.authorName || name
      const when = new Date(message.at).toLocaleString('pt-BR')
      const text = escapeHtml(message.text || message.filename || message.kind || '')
      let media = ''
      if (message.media && message.kind === 'audio') media = `<audio controls src="${message.media}"></audio>`
      else if (message.media && message.kind === 'video') media = `<video controls src="${message.media}"></video>`
      else if (message.media) media = `<img src="${message.media}" alt="" />`
      return `<article><header>${escapeHtml(when)} — ${escapeHtml(who)}</header><p>${text}</p>${media}</article>`
    })
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title><style>body{font-family:sans-serif;background:#0b141a;color:#e9edef;margin:24px}article{margin:0 0 16px;padding:12px;background:#202c33;border-radius:8px}img,video{max-width:320px;display:block}audio{width:280px}</style></head><body><h1>${escapeHtml(name)}</h1>${body || '<p>Sem mensagens.</p>'}</body></html>`
}

export function downloadBlob(filename: string, body: string, type: string) {
  const file = new Blob([body], { type })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(file)
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}
