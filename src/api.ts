import { io } from 'socket.io-client'

export const socket = io('http://127.0.0.1:3001', {
  transports: ['websocket', 'polling'],
  autoConnect: true,
})

type Reply = { ok?: boolean; error?: string }

/**
 * Emits an event and waits for the server's ack, but never forever: if the server dies or
 * takes longer than `timeoutMs`, it resolves with { ok: false, error } instead of hanging the UI.
 */
export function request<T extends object = Reply>(event: string, payload?: unknown, timeoutMs = 90_000) {
  return new Promise<T & Reply>((resolve) => {
    const done = (err: Error | null, res?: T & Reply) => {
      if (!err) {
        resolve((res ?? {}) as T & Reply)
        return
      }
      resolve({
        ok: false,
        error: socket.connected ? 'O servidor demorou demais para responder' : 'Sem conexão com o servidor',
      } as T & Reply)
    }
    if (payload === undefined) socket.timeout(timeoutMs).emit(event, done)
    else socket.timeout(timeoutMs).emit(event, payload, done)
  })
}
