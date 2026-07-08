# PRD: CLI e Daemon local para WhatsApp usando Bun e WhiskeySockets Baileys

## Visão geral

Este projeto tem como objetivo criar uma ferramenta local, distribuída como um único binário Bun, capaz de operar conexões WhatsApp por meio da biblioteca WhiskeySockets Baileys. A ferramenta deve funcionar como uma CLI simples para comandos diretos, mas também possuir um modo daemon persistente para manter conexões ativas, receber eventos, enviar mensagens e expor uma API local privada para comunicação entre os comandos da CLI e o processo principal.

A proposta não é criar mais uma API REST pesada de WhatsApp, nem uma plataforma com dashboard obrigatório, Docker, Redis ou banco externo. A proposta é criar uma ferramenta local-first, leve, scriptável e fácil de embutir em automações, aplicações desktop, agentes de IA ou outros sistemas locais.

O produto deve funcionar como um único executável, por exemplo `wa`, `zap`, `wacli` ou outro nome a definir. Esse mesmo binário deve conseguir rodar em modo daemon e em modo CLI. No modo daemon, ele mantém as sessões do WhatsApp abertas. No modo CLI, ele envia comandos para o daemon local e retorna o resultado no terminal.

## Problema

Hoje é relativamente fácil usar Baileys dentro de uma aplicação Node ou Bun, mas não existe uma experiência simples, local, binária e bem organizada para operar WhatsApp por terminal com suporte a múltiplas sessões, envio de mensagens, escuta de eventos, webhooks e integração com automações locais.

O problema principal está na natureza do WhatsApp via Baileys: para receber mensagens, o processo precisa permanecer vivo. Uma CLI tradicional executa um comando e encerra. Portanto, uma CLI pura não resolve bem eventos de recebimento, reconexão e sessões persistentes. O projeto precisa separar o comando curto do processo persistente.

A solução proposta é criar um daemon local que permanece rodando e mantém o Baileys ativo, enquanto a CLI conversa com esse daemon por uma API local privada.

## Objetivo do produto

Criar uma ferramenta de linha de comando para WhatsApp que permita conectar contas, manter múltiplas sessões, enviar mensagens, receber eventos, escutar mensagens no terminal, registrar webhooks e servir como base para automações locais ou integrações com outros sistemas.

O produto deve ser simples de instalar, simples de rodar e não deve exigir ambiente Node, Bun instalado globalmente, Docker ou serviços externos para o MVP. A distribuição desejada é um binário standalone compilado com Bun.

## Objetivos do MVP

O MVP deve entregar um binário único com dois modos principais: daemon e CLI. O daemon deve manter sessões Baileys ativas, restaurar credenciais, salvar atualizações de autenticação, receber mensagens e expor uma API local. A CLI deve conseguir iniciar o daemon manualmente, conectar uma sessão, listar sessões, mostrar status, enviar mensagens e ouvir eventos em tempo real.

O MVP não precisa instalar serviço no sistema operacional, não precisa iniciar junto com Windows, não precisa ter dashboard web, não precisa ter plugin system e não precisa ter painel visual. Esses recursos podem ficar para fases futuras.

## Não objetivos do MVP

O MVP não deve tentar competir diretamente com plataformas completas como gateways REST corporativos de WhatsApp. Também não deve depender de Redis, PostgreSQL, Docker ou serviços externos. Não deve implementar ainda `service install`, `service uninstall`, autostart no Windows, systemd ou launchd.

Também não é prioridade no MVP criar interface gráfica, marketplace de plugins, gestão avançada de usuários, multi-tenant remoto ou painel administrativo. O foco inicial é ter um binário local robusto, com daemon, CLI, envio, recebimento e eventos.

## Arquitetura desejada

O projeto deve ser estruturado ao redor de um único binário. Esse binário pode ser executado em modo daemon ou em modo cliente CLI.

Quando executado como daemon, ele sobe um processo persistente que carrega as sessões configuradas, inicializa conexões Baileys, registra listeners de eventos e expõe uma API local privada em `127.0.0.1`. Essa API local será usada pelos comandos CLI para conversar com o daemon.

Quando executado como CLI, o binário deve interpretar os argumentos do terminal, montar uma requisição para a API local do daemon, enviar o comando e exibir o resultado. O comando CLI não deve abrir uma nova conexão Baileys para cada execução. A conexão deve pertencer sempre ao daemon.

O desenho conceitual é:

```txt
Mesmo binário
  modo daemon: mantém Baileys vivo
  modo CLI: envia comandos para o daemon
  modo listen: assina eventos vindos do daemon
```

O fluxo interno desejado é:

```txt
Baileys socket
  -> eventos do sock.ev
    -> normalizador de eventos
      -> armazenamento local
        -> event bus interno
          -> clientes CLI em listen
          -> webhooks
          -> integrações futuras
```

## Componentes principais

O projeto deve ser dividido em alguns componentes internos claros.

O primeiro componente é o CLI Router. Ele interpreta comandos como `daemon start`, `connect`, `send`, `sessions`, `status` e `listen`. Ele não deve conter regra pesada de WhatsApp. Ele apenas chama a API local do daemon e renderiza resposta no terminal.

O segundo componente é o Daemon Runtime. Ele é responsável por iniciar o servidor local, carregar configuração, inicializar banco local, restaurar sessões, gerenciar ciclo de vida das conexões e manter o processo vivo.

O terceiro componente é o Session Manager. Ele gerencia múltiplas sessões nomeadas, como `pessoal`, `vendas` ou `suporte`. Cada sessão deve ter seu próprio diretório de credenciais e estado. O Session Manager deve conseguir conectar, desconectar, restaurar, listar e consultar status de cada sessão.

O quarto componente é o Baileys Adapter. Ele encapsula a biblioteca WhiskeySockets Baileys, registra os eventos necessários e converte os objetos internos do Baileys para eventos normalizados do produto. A CLI e o restante do sistema não devem depender diretamente do formato bruto do Baileys.

O quinto componente é o Event Store. Ele persiste eventos relevantes em SQLite ou em outro armazenamento local simples. No MVP, SQLite é o caminho recomendado. Esse armazenamento deve guardar mensagens recebidas, status de entrega de webhooks, erros recentes, informações de sessão e metadados básicos.

O sexto componente é o Event Bus interno. Ele recebe eventos normalizados e distribui para consumidores locais, como o comando `listen`, webhooks e futuramente hooks locais ou plugins.

O sétimo componente é o Local API Server. Ele roda apenas em `127.0.0.1` e deve exigir autenticação por token local. Essa API é usada pela própria CLI para enviar comandos ao daemon.

## Persistência local

A ferramenta deve criar uma pasta de dados local do usuário. O caminho exato pode variar por sistema operacional, mas a estrutura conceitual deve ser parecida com:

```txt
data/
  config.json
  token
  app.sqlite
  sessions/
    pessoal/
      auth/
    vendas/
      auth/
    suporte/
      auth/
```

Cada sessão deve ter um identificador textual definido pelo usuário. Esse identificador será usado nos comandos CLI e também nos eventos. Exemplo: `wa send pessoal 5511999999999 "oi"`.

As credenciais do Baileys devem ser salvas por sessão. Sempre que o Baileys emitir atualização de credenciais, o projeto deve persistir essas alterações imediatamente.

O banco local deve armazenar pelo menos sessões, eventos recebidos, webhooks configurados e tentativas de entrega de webhook. Para o MVP, o banco pode ser simples, mas deve evitar depender apenas de memória.

## Comandos desejados no MVP

O comando para iniciar o daemon manualmente deve ser:

```bash
wa daemon start
```

Esse comando pode rodar em foreground inicialmente. É aceitável que ele mantenha o terminal preso durante o desenvolvimento. Em uma fase posterior, pode existir opção de background.

O comando para verificar status do daemon deve ser:

```bash
wa status
```

Ele deve informar se o daemon está rodando, qual porta local está usando, quais sessões existem e quais estão conectadas.

O comando para conectar uma nova sessão deve ser:

```bash
wa connect pessoal
```

Esse comando deve criar ou restaurar a sessão chamada `pessoal`. Caso a sessão ainda não esteja autenticada, o sistema deve exibir o QR Code no terminal ou fornecer uma forma simples de copiar/visualizar o QR. O comportamento exato pode ser definido durante a implementação.

O comando para listar sessões deve ser:

```bash
wa sessions
```

Ele deve exibir as sessões conhecidas e seus estados, como conectada, desconectada, aguardando QR, reconectando ou com erro.

O comando para enviar mensagem deve ser:

```bash
wa send pessoal 5511999999999 "Olá"
```

Esse comando deve enviar a mensagem usando a sessão `pessoal`. A CLI deve chamar o daemon local, e o daemon deve usar a conexão Baileys ativa para enviar a mensagem.

O comando para ouvir eventos deve ser:

```bash
wa listen pessoal
```

Esse comando deve abrir uma conexão com o daemon e imprimir eventos em tempo real no terminal. O formato recomendado é JSON Lines, um evento JSON por linha, para facilitar integração com scripts.

Também deve existir uma forma de ouvir todas as sessões:

```bash
wa listen --all
```

O comando para desconectar uma sessão pode ser:

```bash
wa disconnect pessoal
```

Ele deve encerrar a conexão ativa daquela sessão sem apagar necessariamente as credenciais.

O comando para remover uma sessão pode ser:

```bash
wa session remove pessoal
```

Esse comando deve exigir cuidado, pois pode apagar credenciais locais. A implementação pode pedir confirmação no terminal ou exigir uma flag explícita, como `--yes`.

## Eventos desejados

O evento principal do MVP é o recebimento de mensagem. O Baileys deve ser escutado por meio de eventos como `messages.upsert`. O sistema deve normalizar as mensagens e emitir um evento próprio chamado `message.received`.

Um evento normalizado pode ter o seguinte formato:

```json
{
  "event": "message.received",
  "sessionId": "pessoal",
  "messageId": "ABC123",
  "chatId": "5511999999999@s.whatsapp.net",
  "from": "5511999999999@s.whatsapp.net",
  "fromMe": false,
  "timestamp": 1780000000,
  "type": "text",
  "text": "oi",
  "raw": {}
}
```

O campo `raw` pode ser opcional ou controlado por configuração, pois o payload bruto do Baileys pode ser grande. Para o MVP, pode ser útil permitir `--raw` no comando `listen`.

Outros eventos úteis para o MVP são `connection.update`, `session.connected`, `session.disconnected`, `session.qr`, `message.sent`, `message.error` e `webhook.delivery_failed`.

O sistema deve tomar cuidado com mensagens sincronizadas ou mensagens antigas. O comportamento padrão deve priorizar mensagens novas em tempo real, provavelmente filtrando eventos do tipo `notify`. Uma opção futura pode permitir incluir histórico ou sincronização.

## Webhooks

O MVP pode incluir webhooks se não aumentar demais o escopo. Caso entre no MVP, o comando sugerido é:

```bash
wa webhook add pessoal https://minha-api.com/whatsapp
```

Quando uma mensagem nova chegar, o daemon deve enviar um POST para a URL cadastrada. O payload deve ser o evento normalizado. O webhook deve ter retry simples, registro de falha e timeout configurável.

Também pode existir:

```bash
wa webhook list pessoal
wa webhook remove pessoal <id>
```

Se o agente de implementação considerar que webhooks aumentam muito o MVP, eles podem entrar como fase dois. Porém a arquitetura deve nascer preparada para isso, por meio do Event Bus interno.

## API local

A API local deve rodar apenas em `127.0.0.1`, nunca aberta diretamente para rede externa no MVP. Ela deve exigir autenticação por token local. Esse token pode ser criado automaticamente no primeiro uso e salvo em arquivo na pasta de dados do usuário.

A CLI deve ler o token local e enviar nas requisições para o daemon. Isso evita que qualquer processo local consiga controlar a ferramenta sem autorização mínima.

Rotas conceituais da API local:

```txt
GET  /health
GET  /status
GET  /sessions
POST /sessions/:sessionId/connect
POST /sessions/:sessionId/disconnect
DELETE /sessions/:sessionId
POST /sessions/:sessionId/send
GET  /events/stream
POST /webhooks
GET  /webhooks
DELETE /webhooks/:id
```

Para streaming de eventos, podem ser avaliadas três opções: Server-Sent Events, WebSocket ou HTTP com JSON Lines. Para o MVP, Server-Sent Events ou JSON Lines são boas opções por simplicidade.

## Comportamento do daemon

O daemon deve iniciar, carregar configuração, abrir o banco local, restaurar sessões conhecidas e tentar reconectar sessões marcadas como ativas. Ele deve expor uma API local para a CLI e manter os listeners do Baileys vivos.

O daemon deve lidar com reconexão de forma segura. Quando uma conexão cair, ele deve atualizar o status da sessão, emitir evento e tentar reconectar quando fizer sentido. Não deve entrar em loop agressivo infinito sem backoff.

O daemon deve salvar credenciais sempre que houver atualização. Esse comportamento é essencial para evitar perda de sessão e problemas de descriptografia.

O daemon deve evitar processar lógica pesada diretamente dentro dos callbacks do Baileys. O ideal é receber o evento, normalizar, persistir e publicar no Event Bus. Entregas de webhook, hooks locais ou integrações devem acontecer fora do callback principal.

## Formato de saída da CLI

A CLI deve ter saída amigável para humanos em comandos como `status`, `sessions` e `connect`. Porém comandos como `listen` devem priorizar saída fácil de processar por scripts.

O comando `listen` deve usar JSON Lines por padrão ou por flag. Exemplo:

```json
{"event":"message.received","sessionId":"pessoal","from":"5511999999999@s.whatsapp.net","text":"oi"}
{"event":"message.received","sessionId":"pessoal","from":"5511888888888@s.whatsapp.net","text":"teste"}
```

Pode existir uma flag `--pretty` para saída visual mais agradável durante desenvolvimento.

## Segurança

A API local deve escutar apenas em localhost. O token local deve ser obrigatório para comandos sensíveis. A ferramenta não deve expor endpoints em rede externa no MVP.

As credenciais de sessão do WhatsApp devem ficar em diretório local do usuário. O projeto deve evitar imprimir dados sensíveis em logs. Logs de debug devem ser opcionais.

O comando de remover sessão deve ser protegido contra exclusão acidental. Idealmente, remover sessão exige confirmação ou flag explícita.

O sistema deve deixar claro que usa Baileys, ou seja, uma abordagem baseada em WhatsApp Web, não a API oficial da Meta. Isso implica risco de instabilidade, logout, mudanças de protocolo e bloqueios. O produto deve ser desenhado com essa realidade em mente.

## Requisitos técnicos

O projeto deve usar Bun como runtime e como empacotador para gerar binário standalone. O binário deve conter o runtime necessário para execução, sem exigir Bun instalado no ambiente final.

A biblioteca principal de WhatsApp deve ser WhiskeySockets Baileys. A persistência local recomendada é SQLite. A API local pode ser implementada com `Bun.serve()` diretamente ou com uma camada leve como Elysia, caso faça sentido. A decisão deve priorizar simplicidade, portabilidade e facilidade de empacotamento.

O projeto deve ser escrito em TypeScript. O código deve separar domínio, adapters e infraestrutura para evitar acoplamento direto entre CLI e Baileys.

## Estrutura de código sugerida

Uma estrutura inicial possível:

```txt
src/
  main.ts
  cli/
    router.ts
    commands/
      daemon.ts
      connect.ts
      send.ts
      sessions.ts
      listen.ts
      status.ts
  daemon/
    startDaemon.ts
    localApi.ts
    sessionManager.ts
    eventBus.ts
  baileys/
    createSocket.ts
    baileysAdapter.ts
    normalizeMessage.ts
  storage/
    db.ts
    sessionsRepo.ts
    eventsRepo.ts
    webhooksRepo.ts
  config/
    paths.ts
    token.ts
    config.ts
  shared/
    types.ts
    errors.ts
    logger.ts
```

Essa estrutura não é obrigatória, mas o projeto deve manter separação clara entre CLI, daemon, Baileys, persistência e tipos compartilhados.

## Critérios de aceite do MVP

O MVP será considerado funcional quando for possível compilar um único binário e executar manualmente o daemon. Com o daemon rodando, deve ser possível conectar uma sessão WhatsApp, salvar credenciais, parar e iniciar novamente o daemon sem perder a sessão, listar sessões, enviar uma mensagem por comando CLI e receber mensagens pelo comando `listen`.

Também deve ser possível manter pelo menos duas sessões nomeadas no mesmo daemon, com estados separados e envio de mensagem especificando qual sessão será usada.

O comando `listen` deve receber eventos em tempo real vindos do daemon, e não de uma nova conexão Baileys aberta pela própria CLI.

O sistema deve persistir eventos básicos em banco local e deve registrar erros importantes de conexão, envio ou recebimento.

## Roadmap sugerido

A primeira fase deve implementar o esqueleto do binário, roteamento de comandos e modo daemon. Nessa fase, o daemon pode apenas subir API local, responder `health` e manter processo vivo.

A segunda fase deve implementar storage local, configuração, token local e comunicação entre CLI e daemon.

A terceira fase deve implementar Session Manager com Baileys, autenticação por QR Code, persistência de credenciais e restauração de sessão.

A quarta fase deve implementar envio de mensagens via CLI, usando sessão já conectada no daemon.

A quinta fase deve implementar recebimento de eventos, normalização de mensagens, Event Bus interno e comando `listen`.

A sexta fase deve implementar multi-sessão de forma mais robusta, com status por sessão, reconexão, desconexão e remoção de sessão.

A sétima fase pode implementar webhooks, retry e histórico de entregas.

Fases futuras podem incluir hooks locais, plugins, dashboard web opcional, instalação como serviço do sistema operacional, autostart no login, distribuição com instalador, modo servidor remoto e suporte a integrações específicas com agentes de IA.

## Decisões importantes para o agente analisar

O agente deve avaliar qual é o melhor mecanismo de streaming para o comando `listen`: Server-Sent Events, WebSocket ou JSON Lines via HTTP. A prioridade é simplicidade e compatibilidade com terminal.

O agente deve avaliar se a API local deve usar `Bun.serve()` puro ou um framework leve. A prioridade é empacotamento simples e baixa dependência.

O agente deve avaliar a melhor biblioteca SQLite para Bun e o impacto disso no binário compilado.

O agente deve avaliar a melhor forma de gerar e exibir QR Code no terminal.

O agente deve avaliar como lidar com reconexão, logout, conflitos de sessão, mensagens antigas e eventos duplicados.

O agente deve avaliar como desenhar os tipos normalizados de mensagem, considerando texto, imagem, áudio, documento, sticker, grupo e mensagens de sistema. Para o MVP, texto pode ser suficiente, mas o modelo deve permitir expansão.

## Premissas

O usuário final executará inicialmente o daemon manualmente. Não haverá instalação automática como serviço no MVP.

O produto será local-first. Não haverá servidor externo obrigatório.

Cada sessão será identificada por um nome textual escolhido pelo usuário.

O daemon será a única parte que conversa diretamente com Baileys. A CLI sempre conversará com o daemon.

O projeto deve nascer simples, mas com arquitetura suficiente para crescer sem precisar reescrever tudo.

## Resultado esperado

Ao final do MVP, o usuário deve conseguir baixar ou compilar um único binário, rodar o daemon, conectar uma ou mais contas WhatsApp, enviar mensagens pelo terminal e ouvir mensagens recebidas em tempo real.

A experiência desejada é próxima de ferramentas CLI modernas: simples, scriptável, previsível e boa para automações. O projeto deve funcionar como uma ponte local entre WhatsApp e qualquer sistema que saiba chamar CLI, consumir eventos JSON ou receber webhooks.
