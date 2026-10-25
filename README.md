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
wa daemon start --background --json
wa daemon stop --json
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

## Ciclo de vida do daemon

`wa daemon start` sobe o servidor local em primeiro plano, como sempre. Para ser
ligado e desligado por outro programa (o vigia de servidores do Studio, um
agente, um script) existem dois verbos que respondem com **um unico objeto
JSON** em `--json`:

```bash
wa status --json                         # { "running": ..., "processAlive": ..., ... }
wa daemon start --background --json      # destacado deste processo
wa daemon stop --json [--wait-ms 7500]   # gracioso, com recurso a forca
```

**`daemon start --background`** reexecuta o proprio programa em `daemon start`,
destacado de quem o chamou: sessao e grupo de processos proprios no Linux; sem
janela e sobrevivendo ao fim do processo que o chamou no Windows (criado com
`CreateProcessW` e uma lista explicita de handles, para o daemon nao segurar
aberto o pipe de saida de quem chamou o verbo). stdin fica fechado e
stdout/stderr sao **acrescentados** ao `daemon.log` do diretorio de dados, que
nunca e truncado nem reescrito. Cada partida destacada escreve nele uma linha de
cabecalho (data, versao, pid e porta):

```text
=== wa-control daemon | inicio 2026-10-24T20:00:00.000Z | versao 0.8.0 | pid 4321 | porta 43119 ===
```

O verbo espera ate 7 s e responde:

| Resposta | Quando |
| --- | --- |
| `{ "ok": true, "ready": true }` | o `/health` do processo recem-criado respondeu 2xx |
| `{ "ok": true, "ready": false }` | os 7 s acabaram com o processo vivo; confira com `wa status --json` |
| `{ "ok": false, "detail": "<motivo>" }` | ja ha daemon vivo para o diretorio de dados, ou o processo morreu (motivo da guarda ou fim do log) |

A resposta e sempre o objeto, com exit 0, para quem le a saida nao perder o
`detail` por um codigo de saida. Sem `--json`, a recusa sai com exit 1.

**`daemon stop`** le o registro de partida (`runtime.json`). Sem processo vivo,
responde `{ "ok": true, "stopped": true, "alreadyStopped": true }`. Com processo
vivo, pede `POST /shutdown` a API local, autenticado pelo mesmo token das demais
rotas; o daemon executa a mesma parada graciosa dos handlers de `SIGINT` e
`SIGTERM` (que no Windows nao existem como sinal, por isso o pedido HTTP). O
verbo so responde depois de a morte ser confirmada:

```json
{ "ok": true, "stopped": true, "alreadyStopped": false, "graceful": true, "pid": 4321, "elapsedMs": 150 }
```

`--wait-ms` (padrao 7500, o orcamento que o Studio passa ao fechar) e o
orcamento do verbo inteiro: a janela graciosa e o orcamento menos uma reserva
(de 400 ms a 1,5 s) para forcar e confirmar. Sem token, com a API muda, com a
API ainda fechada (partida em andamento), ou com um daemon anterior a esta versao
(sem a rota), o verbo espera a janela, forca pelo pid do registro (no Linux,
`SIGTERM` e depois `SIGKILL`; no Windows, `TerminateProcess`), confirma a morte e
responde `"graceful": false`. Nunca sinaliza um pid que foi reaproveitado por
outro programa. Se a morte nao puder ser confirmada, responde
`{ "ok": false, "detail": "..." }` e sai com 1. O tipo de cada parada fica no
`daemon.log` (`parada graciosa confirmada` ou `parada forcada`, com o motivo).

**Uma instancia por diretorio de dados.** A partida cria o `runtime.json` de forma
exclusiva antes de abrir o banco; duas partidas simultaneas (destacadas, em
primeiro plano ou misturadas) terminam com um processo e uma recusa. A guarda
nao cobre um daemon vivo em outra porta com o `runtime.json` apagado.

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

O executavel Windows e gerado sem `--bytecode`: compilado a partir do Linux com
essa flag, o binario cai em segfault ao iniciar (Bun 1.3.14), qualquer que seja o
comando.

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
