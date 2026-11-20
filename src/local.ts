import type { CommandMessage } from './types'

export type ThemeId = 'default' | 'doodle' | 'green' | 'sand'

export type LocalList = {
  id: string
  name: string
  contactIds: string[]
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function write(key: string, value: unknown) {
  localStorage.setItem(key, JSON.stringify(value))
}

export function loadDrafts() {
  return read<Record<string, string>>('zap-drafts', {})
}

export function saveDrafts(drafts: Record<string, string>) {
  write('zap-drafts', drafts)
}

export function loadTheme(): ThemeId {
  const theme = localStorage.getItem('zap-theme')
  if (theme === 'doodle' || theme === 'green' || theme === 'sand' || theme === 'default') return theme
  return 'default'
}

export function saveTheme(theme: ThemeId) {
  localStorage.setItem('zap-theme', theme)
}

export function savedPin() {
  return localStorage.getItem('zap-pin') || ''
}

export function savePin(pin: string) {
  localStorage.setItem('zap-pin', pin)
}

export function loadLocked() {
  return read<string[]>('zap-locked', [])
}

export function saveLocked(ids: string[]) {
  write('zap-locked', ids)
}

export function loadLists() {
  return read<LocalList[]>('zap-lists', [])
}

export function saveLists(lists: LocalList[]) {
  write('zap-lists', lists)
}

export function loadAppLocked() {
  return localStorage.getItem('zap-app-lock') === '1'
}

export function saveAppLocked(locked: boolean) {
  localStorage.setItem('zap-app-lock', locked ? '1' : '0')
}

export function loadPins() {
  return read<Record<string, string[]>>('zap-pins', {})
}

export function savePins(pins: Record<string, string[]>) {
  write('zap-pins', pins)
}

export function loadCommandLog() {
  return read<CommandMessage[]>('zap-commands', [])
}

export function saveCommandLog(items: CommandMessage[]) {
  write('zap-commands', items.slice(-200))
}
