# Homologacao manual do MVP

Este roteiro fecha os criterios do PRD que dependem de uma conta real do WhatsApp.

## Pre-condicoes

- binario compila com `bun run build`
- daemon sobe com `wa daemon start`
- voce tem uma conta WhatsApp disponivel para escanear QR
- voce tem um segundo numero ou contato de teste para validar envio e recebimento

## Passo a passo

1. Inicie o daemon:

```bash
wa daemon start
```

2. Em outro terminal, conecte uma sessao:

```bash
wa connect pessoal
```

Resultado esperado:
- QR Code aparece no terminal
- apos o scan, `wa sessions` mostra `pessoal` como `connected`

3. Valide persistencia e restauracao:

```bash
wa sessions
wa status
```

Pare o daemon com `Ctrl+C`, suba novamente e rode:

```bash
wa sessions
wa status
```

Resultado esperado:
- a sessao `pessoal` volta conectada sem pedir novo QR

4. Valide envio:

```bash
wa send pessoal 5511999999999 "teste wa-control"
```

Resultado esperado:
- comando retorna sucesso com `messageId`
- a mensagem chega no destino

5. Valide recebimento e `listen`:

```bash
wa listen pessoal
```

Envie uma mensagem para a conta autenticada.

Resultado esperado:
- o terminal imprime uma linha JSON com `event: "message.received"`
- o evento vem do daemon, nao de uma conexao Baileys aberta pela CLI

6. Valide `listen --raw`:

```bash
wa listen pessoal --raw
```

Resultado esperado:
- eventos `message.received` incluem o campo `raw`

7. Valide multi-sessao:

```bash
wa connect vendas
wa sessions
```

Resultado esperado:
- `pessoal` e `vendas` aparecem separadas
- cada uma pode ser usada no `send`

8. Valide webhook:

```bash
wa webhook add pessoal https://sua-url/hook
wa webhook list pessoal
wa webhook deliveries pessoal
```

Envie uma mensagem para a conta autenticada.

Resultado esperado:
- o endpoint recebe POST com o evento normalizado
- `wa webhook deliveries pessoal` registra sucesso ou falha

## Encerramento

Se todos os passos acima passarem, os criterios operacionais do MVP ficam comprovados com evidencia real.
