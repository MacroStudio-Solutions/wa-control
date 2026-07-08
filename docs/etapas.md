# Etapas do projeto

## Fase 1: Binario, CLI e modo daemon

Objetivo:
- criar o entrypoint unico
- implementar roteamento CLI
- subir o daemon em foreground com API local basica

Status atual:
- concluida no scaffold inicial

## Fase 2: Infraestrutura local

Objetivo:
- definir pasta de dados
- persistir configuracao, runtime e token local
- inicializar SQLite e repositorios basicos
- fazer a CLI conversar com o daemon por HTTP local autenticado

Status atual:
- concluida no scaffold inicial

## Fase 3: Session Manager com Baileys

Objetivo:
- integrar `@whiskeysockets/baileys`
- autenticar por QR Code
- persistir credenciais por sessao
- restaurar sessoes ao reiniciar o daemon

Entregas previstas:
- adapter Baileys
- armazenamento de auth state
- estados `awaiting_qr`, `connected`, `reconnecting`, `error`

Status atual:
- implementada
- validada em runtime com QR real no terminal
- restauracao de sessao ativa validada ao reiniciar o daemon
- autenticacao completa ainda depende de escanear o QR com uma conta real

## Fase 4: Envio de mensagens

Objetivo:
- enviar mensagens via sessoes conectadas
- validar erros de sessao offline e destino invalido
- emitir `message.sent` e `message.error`

Status atual:
- implementada na CLI, API local e Session Manager
- validacao de erro de sessao offline coberta
- envio real ainda depende de uma sessao autenticada por QR

## Fase 5: Recebimento de eventos

Objetivo:
- escutar `messages.upsert`
- normalizar `message.received`
- persistir eventos
- expor stream em NDJSON para `wa listen`

Status atual:
- implementada
- stream NDJSON validado em runtime
- recebimento real ainda depende de uma sessao autenticada e de uma mensagem de teste

## Fase 6: Multi-sessao robusto

Objetivo:
- reconexao com backoff
- desconexao e remocao com limpeza de credenciais
- status detalhado por sessao
- tratamento de logout e conflito de sessao

Status atual:
- implementada
- remocao com limpeza local validada em runtime
- reconexao, logout e conflito implementados, mas ainda carecem de validacao com conta real

## Fase 7: Webhooks

Objetivo:
- CRUD de webhooks
- retries simples
- historico de entregas e falhas

Status atual:
- implementada
- CRUD validado em runtime
- retries e `webhook.delivery_failed` validados em runtime
- historico persistido em SQLite e exposto por CLI/API

## Decisoes tecnicas assumidas

- API local: `Bun.serve()` puro
- streaming: NDJSON por HTTP para simplificar terminal e scripts
- persistencia: `bun:sqlite`
- seguranca local: `127.0.0.1` + token em arquivo
- arquitetura: CLI, daemon, storage e tipos compartilhados separados desde o inicio
