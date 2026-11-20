# Chat Zap — manual test script (fake WhatsApp)

**Time:** about 60–75 minutes for everything. Sections 1–6 and 9–11 matter most.
**Safe:** fake mode never touches your real WhatsApp. Restarting the server resets all fake data.

The automated tests (`npm test`) already check the command logic: names, accents and verb forms.
This script checks what they can't: **what you see and click, end to end, in the browser.**

How to use it:
- Do each test, then tick the box: `- [x]`.
- If something is wrong, write it in the **Problems** table at the bottom: test number, what you did, what happened.
- An "Expect" that doesn't happen exactly as written **is a problem**. Write it down, even if it's small.

---

## 0. Setup

- [ ] **0.1** Open a terminal in `c:\chat-zap` and run `npm run dev:fake`.
  **Expect:** the terminal shows `[fake] MODO TESTE: WhatsApp de mentira...` and `WhatsApp backend em http://127.0.0.1:3001`, with no red errors.
- [ ] **0.2** Open **http://localhost:5173** in Chrome.
  **Expect:** the app opens without a QR code. You're logged in as **"Modo teste"**.
- [ ] **0.3** Press **F12** → **Console** tab. Keep it open during the whole test.
  **Expect:** no red errors. If red errors appear during any test, note the test number and copy the error.

Fake data you'll use:

| People | Groups (you are admin?) |
|---|---|
| Ana Souza, Pedro Lima, Bruno, André Costa, Érica, Mãe, José, Loja do Bairro | Família (yes), Trabalho (yes), Grupo da Faculdade (yes), Vagas T.I. (**no**), Condomínio Jardim (**no**, archived) |

---

## 1. First look

- [ ] **1.1** Look at the chat list.
  **Expect:** 12 chats visible (Condomínio is archived, so it's hidden). **Família** is pinned at the top. **Vagas T.I.** shows a muted icon.
- [ ] **1.2** Check the unread badges.
  **Expect:** a number on **Ana Souza (1)**, **Mãe (2)**, **Loja do Bairro (1)** and **Vagas T.I. (2)**.
- [ ] **1.3** Check the photos.
  **Expect:** every chat has a colored circle with initials. None broken or empty.
- [ ] **1.4** Read every text on the screen.
  **Expect:** nothing cut off, overlapping or in English by mistake. Note any Portuguese that sounds strange.

## 2. Chat list

- [ ] **2.1** Click the **Não lidas** filter.
  **Expect:** only chats with unread messages. Then click **Todas** and everything comes back.
- [ ] **2.2** Click **Grupos**.
  **Expect:** only the 4 non-archived groups.
- [ ] **2.3** Click **Favoritos**.
  **Expect:** only Família.
- [ ] **2.4** Click **Arquivadas**.
  **Expect:** only **Condomínio Jardim**. Click it again and you're back to the normal list.
- [ ] **2.5** In "Pesquisar ou começar uma nova conversa", type `pedro`, then `PEDRO`, then `andre` (no accent).
  **Expect:** it finds Pedro Lima both times, and finds **André Costa** without the accent.
- [ ] **2.6** Clear the search.
  **Expect:** the full list is back.

## 3. Reading conversations

- [ ] **3.1** Open **Ana Souza**.
  **Expect:** 4 messages in order (oldest at top). The unread badge disappears.
- [ ] **3.2** Open **Pedro Lima**.
  **Expect:** your message "Mandei o pix agora!" has a **👍** reaction under it.
- [ ] **3.3** Open **José**.
  **Expect:** "Bora! Que horas?" shows a **quote** of "Vamos no jogo sábado?" above it.
- [ ] **3.4** Open **André Costa**.
  **Expect:** a landscape picture (sky, sun, green hills) with "Olha essa vista!". Click it and it opens bigger, or downloads.
- [ ] **3.5** Open **Érica**.
  **Expect:** a document **orcamento.txt**. Download it, open it, and the text reads "Orçamento de teste..." with correct accents.
- [ ] **3.6** Open **Família**.
  **Expect:** a poll **"Almoço de domingo"**: Churrasco 2 votes, Pizza 1, Lasanha 0.
- [ ] **3.7** Open **Bruno** and scroll all the way up.
  **Expect:** older messages load ("Mensagem antiga nº 1" ... nº 60). No duplicates, no jumps, order stays correct.
- [ ] **3.8** Switch quickly between 5 chats.
  **Expect:** each chat shows **its own** messages, never another chat's messages.

## 4. Sending in the normal message box

- [ ] **4.1** Open **Ana Souza**. Type `oi` in "Digite uma mensagem" and press **Enter**.
  **Expect:**
  - It sends right away, with no confirmation (like WhatsApp).
  - The ticks go 1 → 2 (~1 s) → blue (~3 s).
  - At the top, Ana shows **"digitando..."**, then answers **"Oi! 😊 Tudo bem?"**.
- [ ] **4.2** Send `que horas você chega?`.
  **Expect:** Ana answers "Hmm, deixa eu ver e já te respondo."
- [ ] **4.3** Send `Ação, coração, pão 🍞🎉 "aspas" & <tag>`.
  **Expect:** it appears **exactly** like that: accents, emojis, quotes, `&` and `<tag>` all intact.
- [ ] **4.4** Type only spaces and press Enter.
  **Expect:** nothing is sent.
- [ ] **4.5** Paste a very long text (10+ lines) and send it.
  **Expect:** the bubble wraps nicely, and the layout doesn't break.
- [ ] **4.6** Open **Trabalho** and send `teste no grupo`.
  **Expect:** after ~3 s someone reacts **👍** to your message.
- [ ] **4.7** Use the emoji button (😊) to insert an emoji and send it.
  **Expect:** the emoji arrives correctly.

## 5. Message actions

Right-click a message, or use the chat menu → **Selecionar mensagens** → click a message.

- [ ] **5.1** **Responder:** reply to Ana's "Me manda o relatório..." with `já mando`.
  **Expect:** your message shows the quote, and the box shows "Respondendo: ..." before you send.
- [ ] **5.2** **React:** pick ❤️ on one of Ana's messages.
  **Expect:** ❤️ appears under it.
- [ ] **5.3** **Editar:** edit your message from 4.1 to `oi, tudo bem?`.
  **Expect:** the text changes, marked as edited.
- [ ] **5.4** **Editar** an old message of yours ("Tudo ótimo e você?", from yesterday).
  **Expect:** a clear error: "Só dá para editar uma mensagem sua recente (até 15 minutos)".
- [ ] **5.5** **Apagar → Para mim** on one of your messages.
  **Expect:** a confirmation dialog first. After **Confirmar**, the message disappears.
- [ ] **5.6** **Apagar → Para todos** on one of your messages.
  **Expect:** a confirmation dialog, then the message shows as deleted.
- [ ] **5.7** **Apagar → Para todos** on one of **Ana's** messages.
  **Expect:** error "Só dá para apagar para todos as suas mensagens". Nothing is deleted.
- [ ] **5.8** **Encaminhar** a message, and type `Bruno` when asked.
  **Expect:** a confirmation dialog naming Bruno. After confirming, the message is in Bruno's chat.
- [ ] **5.9** **Encaminhar**, and type a name that doesn't exist (`Zezinho`).
  **Expect:** a clear message, and nothing is forwarded.
- [ ] **5.10** **Estrela**, then open the chat menu → **Mensagens favoritas**.
  **Expect:** the message is listed. **Tirar estrela** removes it.
- [ ] **5.11** **Fixar** a message.
  **Expect:** "Mensagem fixada" appears at the top of the chat. **Desafixar** removes it.
- [ ] **5.12** **Copiar** a message and paste it in Notepad.
  **Expect:** exactly the same text.
- [ ] **5.13** **Info** on one of your sent messages.
  **Expect:** "Lida: ... · Entregue: ...".
- [ ] **5.14** Select **3 messages** at once and react 👍.
  **Expect:** all 3 get 👍.

## 6. Files and photos

Get these ready first: a normal photo (.jpg), a PDF, a short audio file, and any file **bigger than 20 MB**.

- [ ] **6.1** In **Ana Souza**, click **Foto**, pick the .jpg and add a caption `minha foto`.
  **Expect:**
  - The confirmation dialog names **Ana Souza**, the file name and the caption.
  - After confirming, the photo appears with the caption.
  - Ana answers "Beleza!" or something similar.
- [ ] **6.2** Do the same, but click **Cancelar** in the dialog.
  **Expect:** nothing is sent.
- [ ] **6.3** **Drag and drop** the photo into the chat.
  **Expect:** "Solte a imagem para enviar" appears, then the confirmation dialog.
- [ ] **6.4** Copy an image (e.g. a screenshot with Win+Shift+S) and **paste it** (Ctrl+V) in the message box.
  **Expect:** it is offered for sending.
- [ ] **6.5** Send the **PDF** with 📎 → **Foto, vídeo ou documento**.
  **Expect:** it arrives as a document with the right file name.
- [ ] **6.6** Send the **audio** file.
  **Expect:** a play button. Clicking it plays the audio.
- [ ] **6.7** Try the **>20 MB** file.
  **Expect:** "Arquivo grande demais. O limite é 20 MB." Nothing is sent.
- [ ] **6.8** Close every chat ("Selecione uma conversa à esquerda") and drop a photo.
  **Expect:** "Abra uma conversa antes de soltar a imagem."

## 7. Polls

- [ ] **7.1** In **Família**, vote **Pizza** on "Almoço de domingo".
  **Expect:** Pizza goes up to 2, and your vote is marked.
- [ ] **7.2** Change your vote to **Lasanha**.
  **Expect:** Pizza goes back to 1 and Lasanha goes to 1. You never count twice.
- [ ] **7.3** Remove your vote.
  **Expect:** the counts are back to the original (2 / 1 / 0).
- [ ] **7.4** In **Trabalho**, use 📎 → poll, and type `Almoço | pizza | sushi`.
  **Expect:** a new poll appears. After a few seconds, group members vote on it.
- [ ] **7.5** Create a poll with only one option: `Almoço | pizza`.
  **Expect:** a clear error ("Use: enquete Pergunta | opção 1 | opção 2"), and no broken poll.

## 8. Chat menu (⋮ at the top of a chat)

- [ ] **8.1** **Silenciar por 8 horas** on Ana.
  **Expect:** a muted icon in the list. **Ativar notificações** removes it.
- [ ] **8.2** **Arquivar** Pedro.
  **Expect:** he leaves the list and shows up under **Arquivadas**. **Desarquivar** brings him back.
- [ ] **8.3** **Adicionar aos favoritos** on Ana, then on Bruno. Then try a 4th, José.
  **Expect:** Ana and Bruno go to the top. José fails with "Não deu para fixar. O topo já pode estar cheio." (max 3).
- [ ] **8.4** **Temporárias: 7 dias** on Ana, then **Desligar temporárias**.
  **Expect:** a note confirms each change.
- [ ] **8.5** **Tema da conversa**, clicked 4 times.
  **Expect:** the background cycles through escuro → desenhado → verde → areia, and the text stays readable on each.
- [ ] **8.6** **Travar** Ana with PIN `1234`. Leave the chat and come back.
  **Expect:** "Conversa travada", and the messages are hidden. Enter `0000` and you get "PIN incorreto". Enter `1234` and it opens.
- [ ] **8.7** **Exportar conversa** on Ana.
  **Expect:** an .html file downloads. Open it: all messages are there, accents are correct, and the order is right.
- [ ] **8.8** **Marcar como não lida** on Ana.
  **Expect:** an unread dot or badge appears in the list.
- [ ] **8.9** **Limpar conversa** on Érica.
  **Expect:** a confirmation dialog first. After confirming, the chat is empty.
- [ ] **8.10** **Bloquear** Loja do Bairro (confirm), then try to send `oi`.
  **Expect:** error "Você bloqueou este contato. Desbloqueie para mandar mensagem." Unblock it and sending works again.
- [ ] **8.11** **Dados do contato** on Ana.
  **Expect:** name, phone **+5511911110001** and about "Disponível".
- [ ] **8.12** **Pesquisar nesta conversa** in Bruno, typing `nº 5`.
  **Expect:** it finds the matching messages, and **Anterior/Próxima** jump between them.
- [ ] **8.13** Lists: create a list named `Trabalho` with Ana.
  **Expect:** a new filter appears in the chat list showing Ana.
- [ ] **8.14** **Chamada de voz** and **Chamada de vídeo** on Ana.
  **Expect:** a clear note that a call was started. Nothing freezes.
- [ ] **8.15** **Fechar conversa**.
  **Expect:** back to "Selecione uma conversa à esquerda".

## 9. Assistant panel and the confirmation dialog (most important)

These commands are typed in the **Assistente** box ("Pergunta ou ação...").

- [ ] **9.1** Type `manda oi pra Ana`.
  **Expect:** a dialog: **Confirmar — Enviar para Ana Souza? "oi"** and "Isso mexe no seu WhatsApp de verdade."
- [ ] **9.2** In that dialog click **Cancelar**.
  **Expect:** nothing is sent to Ana. Check her chat to make sure.
- [ ] **9.3** Repeat 9.1 and press **Esc**.
  **Expect:** it is cancelled. Nothing is sent.
- [ ] **9.4** Repeat 9.1 and click **outside** the dialog.
  **Expect:** it is cancelled. Nothing is sent.
- [ ] **9.5** Repeat 9.1 and press **Enter twice, fast**.
  **Expect:** it does **not** send by accident. You must click **Confirmar**.
- [ ] **9.6** Repeat 9.1 and click **Confirmar**.
  **Expect:** "oi" is in Ana's chat, **only once**.
- [ ] **9.7** Open **Pedro Lima**, then type `responde que chego às 8`.
  **Expect:** the dialog says **Responder Pedro Lima? "chego às 8"**, not another person.
- [ ] **9.8** Type `manda oi pra Zezinho` (doesn't exist).
  **Expect:** a clear message that Zezinho wasn't found. **It must not send to someone else.**
- [ ] **9.9** Type `@ana boa noite` (use the @ suggestion list).
  **Expect:** the suggestions show Ana. The dialog names Ana Souza and the text is "boa noite".
- [ ] **9.10** Type `@Zezinho oi`.
  **Expect:** "Não achei @Zezinho na sua lista".
- [ ] **9.11** Type `manda a localização pra Ana`.
  **Expect:** "O app não envia localização. Mande pelo celular." Nothing is sent as text.
- [ ] **9.12** Try each example from the help list, one by one:
  `o que você faz` · `mostra as não lidas` · `o que chegou hoje` · `cadê o pix do Pedro` · `quem postou status` · `abre a Ana` · `fala com 11999999999` · `marca como lida` · `arquiva a conversa` · `silencia esse grupo por uma semana` (with a group open) · `adiciona aos favoritos` · `reage com 👍` · `apaga a última` · `edita para bom dia` · `encaminha pra Ana` · `enquete Almoço | pizza | sushi`
  **Expect:** each one does what it says, on the **right** chat. Anything that deletes, sends or forwards asks first.
- [ ] **9.13** Type 10 commands **your own way**: slang, abbreviations, typos (`manda um oi p ana`, `abre o zé`, `arquiva isso ai`...).
  **Expect:** you're happy with how it understands. Write every misunderstanding in the Problems table. These become new automated tests.

## 10. Groups

- [ ] **10.1** Type `crie um grupo Viagem com a Ana e o Pedro`.
  **Expect:** after confirming, a group **Viagem** appears with you, Ana and Pedro.
- [ ] **10.2** Open **Trabalho** and type `adiciona o José`.
  **Expect:** the dialog says "Adicionar José ao grupo Trabalho?". After confirming, José is in the member list.
- [ ] **10.3** Type `adiciona o José` again.
  **Expect:** "Essa pessoa já está no grupo."
- [ ] **10.4** Type `promove o José`, then `rebaixa o José`.
  **Expect:** the "admin" tag appears next to José, then goes away.
- [ ] **10.5** Type `remove o Bruno do grupo`.
  **Expect:** the dialog names Bruno **and** Trabalho. After confirming, Bruno is gone.
- [ ] **10.6** Type `muda o nome para Trabalho 2026`.
  **Expect:** the dialog asks to rename **Trabalho**, not any other group, and the name changes everywhere.
- [ ] **10.7** Type `descrição do grupo: só assuntos sérios`.
  **Expect:** the new description shows in **Dados do grupo**.
- [ ] **10.8** Type `gera o link`.
  **Expect:** an invite link is shown.
- [ ] **10.9** Type `muda a foto do grupo` (attach a photo).
  **Expect:** the group picture changes.
- [ ] **10.10** Open **Vagas T.I.** (you're NOT admin) and type `muda o nome para Teste`.
  **Expect:** "O WhatsApp não deixou. Neste grupo, só os admins podem mudar isso." The name does not change.
- [ ] **10.11** Open **Grupo da Faculdade** and type `sai do grupo` (confirm). Then try to send `oi` there.
  **Expect:** "Você não participa mais deste grupo."
- [ ] **10.12** In **Família**, open **Dados do grupo** → search a participant, typing `mãe` and then `mae`.
  **Expect:** Mãe is found both times.

## 11. Bulk send (disparo)

- [ ] **11.1** In the Assistente box, type `@Ana @Bruno @José Bom dia {nome}!`.
  **Expect:** the dialog says **"Enviar para 3 contatos (Ana Souza, Bruno, José)?"**.
- [ ] **11.2** Confirm.
  **Expect:**
  - Progress shows 1/3 → 2/3 → 3/3, about 1 second apart.
  - The button shows "Enviando..." and you **can't** start another send meanwhile.
  - Each person gets their **own** name: Ana gets "Bom dia **Ana**!" (first name only), Bruno gets "Bom dia **Bruno**!", José gets "Bom dia **José**!".
  - Each message shows the **"via disparo"** label.
- [ ] **11.3** Do the same with `{nome_completo}`.
  **Expect:** Ana gets "Ana **Souza**" (the full name).
- [ ] **11.4** Send with the same person twice: `@Ana @Ana oi`.
  **Expect:** Ana receives it **only once**.
- [ ] **11.5** Send to one person only: `@Pedro teste`.
  **Expect:** **no** "via disparo" label.
- [ ] **11.6** Block Loja do Bairro, then send `@Ana @Loja oi`.
  **Expect:** Ana receives it. Loja shows as failed with a clear reason, and the send doesn't stop halfway.
- [ ] **11.7** Bulk send a **photo**: attach the .jpg and type `@Ana @Bruno legenda teste`.
  **Expect:** the dialog names both people and the file. Both receive the photo with the caption.
- [ ] **11.8** Try to bulk send a **PDF** to 2 people.
  **Expect:** "Disparo em massa vale para texto, foto e áudio".

## 12. Other screens

- [ ] **12.1** **Nova conversa** → type `11999990000`.
  **Expect:** "Esse número não está no WhatsApp".
- [ ] **12.2** **Nova conversa** → type `123`.
  **Expect:** "Digite o número com DDD".
- [ ] **12.3** **Nova conversa** → type `11987654321`.
  **Expect:** a new chat opens for that number.
- [ ] **12.4** **Status**.
  **Expect:** Ana ("Partiu praia 🏖️"), Pedro and Érica are listed.
- [ ] **12.5** Post a status `bom dia` (or type `posta um status: bom dia`).
  **Expect:** a confirmation dialog, then the status appears. Posting an empty status gives "Escreva o status ou anexe uma foto".
- [ ] **12.6** In the main search box, type `pix`.
  **Expect:** it finds Pedro's pix messages. Clicking a result opens the right chat.
- [ ] **12.7** Type `trava o app 1234`.
  **Expect:**
  - The screen locks with "Chat Zap travado".
  - A wrong PIN gives "PIN incorreto".
  - `1234` unlocks it.
  - Press **F5** while locked: is it still locked? Write down what happens.

## 13. Notifications and waiting

- [ ] **13.1** When the browser asks to allow notifications, click **Permitir**. Then switch to another browser tab and wait **2–3 minutes**.
  **Expect:** a Windows notification with someone's name ("Tá aí?", "Kkkkkk"...), and the unread badge goes up.
- [ ] **13.2** Leave the app open for **30 minutes**, then use it again.
  **Expect:** still working. Sending works, new messages appear, and the Console has no new red errors.

## 14. Look and size

- [ ] **14.1** Shrink the browser window to **phone width** (~400 px), or use F12 → the phone icon.
  **Expect:** you can still read and use the list, the chat and the Assistente. No horizontal scrolling, and nothing hidden for good.
- [ ] **14.2** Zoom to **150%** (Ctrl +).
  **Expect:** everything still fits and is usable.
- [ ] **14.3** Use only the keyboard (Tab, Enter, Esc) to open a chat and send a message.
  **Expect:** possible, and you can always see where the focus is.

## 15. Restart

- [ ] **15.1** Stop the server (**Ctrl+C** in the terminal) while the page is open.
  **Expect:** the page shows that it's disconnected. It must not freeze or show a blank screen.
- [ ] **15.2** Run `npm run dev:fake` again.
  **Expect:** the page reconnects by itself, or after F5, and everything is back to the original fake data.
- [ ] **15.3** After the restart, check things that are saved **in the browser**: the chat lock from 8.6, the list from 8.13, the chat theme from 8.5.
  **Expect:** write down which ones survived. Decide if that's what you want.

## 16. AI assistant (only if your `.env` has a `CHAT_API_KEY`)

- [ ] **16.1** Type `que dia é hoje?` and `quanto é 15% de 80?`.
  **Expect:** correct answers.
- [ ] **16.2** Type something the local parser won't know: `avisa a Ana que vou me atrasar uns 10 min`.
  **Expect:** it understands. **It still asks for confirmation before sending.**
- [ ] **16.3** Ask something unrelated: `qual a capital da França?`.
  **Expect:** "Não posso ajudar com isso." or a short answer. It must not take any WhatsApp action.
- [ ] **16.4** Remove your internet connection and type 16.2 again.
  **Expect:** a clear error ("O modelo não respondeu" or similar). Nothing freezes.

---

## Problems

| Test | What I did | What I expected | What happened |
|---|---|---|---|
|  |  |  |  |
|  |  |  |  |
|  |  |  |  |

When you're done, send this table to Claude. Each problem gets a fix plus a new automated test, so you never have to check it by hand again.
