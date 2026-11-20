# Chat Zap

A desktop web app for WhatsApp, with a built-in assistant: type what you want in plain Portuguese, like *"manda oi pra Ana"* or *"arquiva a conversa"*, and the app does it, always asking before anything is sent or deleted.

It runs on your own computer and connects to your WhatsApp through WhatsApp Web, the same way a linked device does. A **fake mode** with invented chats lets you try everything without touching a real account.

> [!WARNING]
> This is an unofficial project, not affiliated with WhatsApp or Meta. It uses [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), which automates WhatsApp Web. WhatsApp may ban numbers that send automated or bulk messages. Use a spare number for testing, and only message people who agreed to it.

---

## Features

**Chats**
- Chat list with filters (Não lidas, Hoje, Favoritos, Grupos, Arquivadas), custom lists and search
- Read and send text, emojis, replies, reactions, edits and deletes (for you or for everyone)
- Photos, videos, audio, documents, stickers and GIFs, with drag and drop and paste
- Polls: create, vote, change your vote, see who voted
- Forward, star and pin messages; message info (read / delivered)
- Load older messages, search inside a chat or across all chats
- Mute, archive, pin chats, disappearing messages, block, clear, report
- Status: view and post
- Export a conversation to an HTML file

**Groups**
- Create groups, add, remove, promote and demote members
- Rename, change the description and photo, get the invite link, leave

**Assistant**
- Understands commands in Portuguese locally (no internet needed), including formal and informal verb forms and names with or without accents
- Bulk send (*disparo*) to several people, with `{nome}` and `{nome_completo}` placeholders
- Optional AI model (Gemini, or any OpenAI-compatible endpoint, or local Ollama) for requests the local parser doesn't understand
- A confirmation dialog before anything that sends, deletes, forwards or blocks, always naming who is affected

**Privacy**
- Lock a single chat or the whole app with a 4-digit PIN (stored only in this browser)
- The server only listens on `127.0.0.1`, so other devices on your network can't reach it

---

## Requirements

- **Node.js 22.15 or newer** (tested on Node 24)
- **Google Chrome** installed, for real WhatsApp mode. The app finds it in the default Windows location; elsewhere, set `PUPPETEER_EXECUTABLE_PATH`.
- A phone with WhatsApp, for real mode (not needed for fake mode)

---

## Getting started

```bash
npm install
```

### Fake mode (recommended first)

```bash
npm run dev:fake
```

Open **http://localhost:5173**. The top-left shows **"Modo teste"**.

You get 8 invented people and 5 groups with history, unread messages, a poll, a photo and a document. The fake WhatsApp also simulates:
- Delivery ticks and "digitando..."
- Automatic replies
- Groups where you're not admin
- A random new message every 2 minutes

Nothing here touches a real account. Restarting the server resets everything.

### Real WhatsApp

```bash
npm run dev
```

1. Open **http://localhost:5173**. A QR code appears.
2. On your phone: **WhatsApp → Aparelhos conectados → Conectar um aparelho**, and scan the QR.
3. Your chats load.

The login is saved in `wwebjs_auth/`, so next time it connects without a QR. To log out, type `sair do WhatsApp` in the assistant, or remove the device from your phone.

> Only one server can run at a time (both use port 3001). Stop one with **Ctrl+C** before starting the other.

---

## Configuration

The AI assistant is optional. Without it, the local command parser still handles all the commands in the help list.

To turn it on, copy `.env.example` to `.env` and fill it in:

| Variable | What it does | Default |
|---|---|---|
| `CHAT_API_KEY` | API key for the model (e.g. from Google AI Studio). `GEMINI_API_KEY` also works. | — |
| `CHAT_BASE_URL` | Any OpenAI-compatible endpoint | Gemini's endpoint when a key is set |
| `CHAT_MODEL` | Model name | `gemini-3.5-flash-lite` |
| `PORT` | Server port | `3001` |
| `HOST` | Server address | `127.0.0.1` |
| `PUPPETEER_EXECUTABLE_PATH` | Path to Chrome, if not in the default place | auto-detected |
| `FAKE_WHATSAPP` | `1` starts fake mode, same as `--fake` | — |

With no key and no `CHAT_BASE_URL`, the app looks for a local **Ollama** on `http://127.0.0.1:11434` and uses its first model.

> If you change `PORT`, also change the address in [src/api.ts](src/api.ts), which is fixed to `3001`.

**What the AI receives:** when a request goes to the model, it gets your request, the names in your contact list (up to 80), and the last 6 messages of the open chat. Commands the local parser understands never leave your computer.

---

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Server + web app, real WhatsApp |
| `npm run dev:fake` | Server + web app, fake WhatsApp |
| `npm run dev:server` | Server only (real) |
| `npm run dev:server:watch` | Server only, restarts on code changes |
| `npm run dev:web` | Web app only (Vite, port 5173) |
| `npm test` | Run the automated tests |
| `npm run build` | Type-check and build the web app into `dist/` |

---

## Tests

```bash
npm test
```

The automated tests use Node's built-in test runner. They cover:
- The Portuguese command parser
- Group name matching
- WhatsApp message IDs
- The AI endpoint call
- The fake WhatsApp

The parts a person has to check, like the confirmation dialog, file pickers, sound, notifications and layout, are in the manual checklist: [tests/MANUAL-TEST-SCRIPT.md](tests/MANUAL-TEST-SCRIPT.md).

---

## Project structure

```
server/
  index.ts               Socket.IO server; picks real or fake WhatsApp
  whatsapp.ts            Real WhatsApp, through whatsapp-web.js + Chrome
  fake-whatsapp.ts       Fake WhatsApp with invented data (same API as whatsapp.ts)
  *.browser.js           Scripts that run inside WhatsApp Web to read chats, messages, polls, media
  agent.ts               Optional AI model call
  persist.ts             Chat cache in data/cache.json
src/
  App.tsx                Layout, app lock, confirmation dialog
  store.tsx              App state and server calls
  commands.ts            Local Portuguese command parser
  components/
    WhatsAppPanel.tsx    Chat list, conversation, menus
    CommandChat.tsx      Assistant panel and bulk send
tests/                   Automated tests + manual test script
```

---

## Local files and privacy

These folders hold private data and are excluded by `.gitignore`. **Never commit them.**

| Path | Contains |
|---|---|
| `wwebjs_auth/`, `.wwebjs_cache/` | Your WhatsApp login session |
| `data/` | Cached chats and messages |
| `.env` | Your API key |

Anyone with a copy of `wwebjs_auth/` can use your WhatsApp. If it leaks, remove the device in **WhatsApp → Aparelhos conectados**.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `EADDRINUSE` / port 3001 in use | Another server is running. Stop it with **Ctrl+C**, or close the old terminal. |
| QR never appears / Chrome error | Install Google Chrome, or set `PUPPETEER_EXECUTABLE_PATH` to your Chrome. |
| `--use-system-ca` is not a valid option | Update Node.js to 22.15 or newer. |
| Chats or messages suddenly empty in real mode | WhatsApp Web changed. Update `whatsapp-web.js` (`npm update whatsapp-web.js`) and check the `server/*.browser.js` scripts. |
| "Sem modelo configurado" | The AI isn't set up. Fill in `.env` (see [Configuration](#configuration)), or ignore it: local commands still work. |
