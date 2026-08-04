# wa-control

CLI local-first para operar sessoes do WhatsApp a partir de um unico binario Bun, seguindo o PRD em [.studio/docs/prd-project-wa-control.md](.studio/docs/prd-project-wa-control.md).

## Estado atual

As fases 1 a 7 do roadmap foram implementadas na base do projeto:

- entrypoint unico em TypeScript/Bun
- roteador CLI e daemon local com API privada em `127.0.0.1`
- autenticacao por token local
- persistencia SQLite local
- Session Manager com Baileys e auth state por sessao
- QR Code no terminal via `wa connect <sessionId>`
- restauracao automatica de sessoes ativas ao reiniciar o daemon
- envio real de mensagens via daemon
- stream NDJSON para `wa listen`
- read model SQLite para `chats`, `contacts` e `messages`
- CRUD de webhooks com retries e historico de entregas

## Comandos disponiveis

```bash
wa daemon start
wa status
wa sessions
wa chats pessoal --limit 20
wa contacts pessoal --limit 20
wa messages pessoal 5511999999999 --limit 20
wa connect pessoal
wa disconnect pessoal
wa session remove pessoal --yes
wa send pessoal 5511999999999 "Ola"
wa listen pessoal --raw
wa listen --all
wa webhook add pessoal https://minha-api.local/hook
wa webhook list pessoal
wa webhook remove <id>
wa webhook deliveries pessoal
```

## Evento de mensagem recebida

O webhook recebe o evento ja normalizado, nao o formato cru do Baileys:

```json
{
  "id": "9f1c...",
  "event": "message.received",
  "sessionId": "pessoal",
  "timestamp": 1785849522,
  "messageId": "3EB0...",
  "chatId": "88356755087579@lid",
  "chatType": "direct",
  "chatLid": "88356755087579@lid",
  "chatPhoneNumber": "556784020665",
  "from": "556784020665@s.whatsapp.net",
  "fromLid": "88356755087579@lid",
  "fromPhoneNumber": "556784020665",
  "senderResolved": true,
  "pushName": "Priscila",
  "fromMe": false,
  "type": "text",
  "text": "Bom dia"
}
```

Desde o rollout de LID do WhatsApp, `chatId` costuma vir como identificador
opaco (`@lid`) em vez do numero. Para filtrar por contato use
`fromPhoneNumber` (so digitos) ou `from`, nunca `chatId`.

`senderResolved` diz se o numero foi realmente descoberto. Quando ele e `false`,
`fromPhoneNumber` e `chatPhoneNumber` vem nulos e `from` cai no identificador
opaco — que continua estavel dentro da sessao, mas nao e o numero que o operador
conhece. Isso acontece quando o WhatsApp nao revela o numero no envelope e o
par LID<->numero ainda nao foi aprendido; nao existe consulta ao servidor que
traduza um LID de volta para numero depois do fato.

O pareamento e aprendido do envelope da mensagem e da lista de contatos, e fica
gravado na pasta de auth da sessao, entao sobrevive a reinicios do daemon.

Em grupos, `chatId` e o grupo e `from` e o participante; `chatPhoneNumber` e
`chatLid` vem nulos.

## Desenvolvimento

```bash
bun install
bun run check
bun run test
bun run dev -- help
```

Para gerar o binario local:

```bash
bun run build
```

Para gerar artefatos de distribuicao para usuarios finais sem ambiente dev:

```bash
bun run build:release:linux-x64
bun run build:release:windows-x64
bun run build:release
```

Os artefatos ficam em `dist/release/`:

- `wa-control-v<versao>-linux-x64/wa`
- `wa-control-v<versao>-linux-x64.tar.gz`
- `wa-control-v<versao>-windows-x64/wa.exe`
- `wa-control-v<versao>-windows-x64.zip`

Para compilar e instalar o binario no ambiente do usuario:

```bash
bun run install:local
source ~/.bashrc
wa help
```

O instalador copia o binario para `~/.local/bin/wa`. Se `~/.local/bin` ainda nao estiver no `PATH`, ele registra essa pasta no arquivo de shell atual (`.bashrc` ou `.zshrc`).

## Etapas

O detalhamento atualizado das fases esta em [.studio/docs//etapas.md](./.studio/docs//etapas.md).

O roteiro de validacao manual com uma conta real esta em [.studio/docs//homologacao.md](./.studio/docs//homologacao.md).
