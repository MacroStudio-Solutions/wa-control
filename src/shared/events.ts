import { AppError } from "./errors.ts";

/**
 * Catalogo dos eventos que um webhook pode assinar.
 *
 * Nem todo evento publicado no barramento chega a um webhook: o despachante
 * ignora eventos sem sessao (`daemon.started`) e os proprios eventos de webhook
 * (`webhook.*`), senao uma falha de entrega geraria outra entrega. Este catalogo
 * lista exatamente o que sobra — o que faz sentido oferecer para assinatura.
 */
export const WEBHOOK_EVENTS = [
  "message.received",
  "message.sent",
  "message.error",
  "session.connected",
  "session.disconnected",
  "session.qr",
  "session.connect_requested",
  "session.removed",
  "connection.update"
] as const;

export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/**
 * Chave estavel, sem ponto, para cada evento.
 *
 * Existe porque um consumidor que le o registro por caminho — a view do
 * Construtor, por exemplo — nao consegue distinguir `message.received` como
 * chave literal de `message` seguido de `received` como travessia. As flags
 * derivadas usam estas chaves para continuar enderecaveis.
 */
export const WEBHOOK_EVENT_KEYS: Record<WebhookEventName, string> = {
  "message.received": "messageReceived",
  "message.sent": "messageSent",
  "message.error": "messageError",
  "session.connected": "sessionConnected",
  "session.disconnected": "sessionDisconnected",
  "session.qr": "sessionQr",
  "session.connect_requested": "sessionConnectRequested",
  "session.removed": "sessionRemoved",
  "connection.update": "connectionUpdate"
};

export function isWebhookEvent(value: string): value is WebhookEventName {
  return (WEBHOOK_EVENTS as readonly string[]).includes(value);
}

/**
 * Normaliza uma lista de eventos vinda da CLI ou da API.
 *
 * Uma lista vazia significa "todos os eventos" e e representada como vazia, nao
 * como a lista completa: assim um webhook criado hoje continua recebendo um
 * evento novo que o runtime passe a publicar amanha, sem precisar ser reeditado.
 */
export function normalizeEventSelection(values: readonly string[]): WebhookEventName[] {
  const selected = new Set<WebhookEventName>();

  for (const value of values) {
    const trimmed = value.trim();

    if (!trimmed) {
      continue;
    }

    if (trimmed === "all" || trimmed === "*") {
      return [];
    }

    if (!isWebhookEvent(trimmed)) {
      throw new AppError(
        "UNKNOWN_EVENT",
        400,
        `Evento desconhecido: '${trimmed}'. Use \`wa events\` para ver a lista.`
      );
    }

    selected.add(trimmed);
  }

  return WEBHOOK_EVENTS.filter((event) => selected.has(event));
}

/** Divide o valor de `--events`, que aceita virgula e espaco. */
export function parseEventList(raw: string): WebhookEventName[] {
  return normalizeEventSelection(raw.split(/[,\s]+/));
}

/**
 * Um webhook sem selecao recebe tudo; com selecao, so o que esta nela.
 */
export function webhookAcceptsEvent(events: readonly string[], eventName: string): boolean {
  return events.length === 0 || events.includes(eventName);
}

/** Flags por evento, para consumidores que so sabem testar verdadeiro/falso. */
export function buildEventFlags(events: readonly string[]): Record<string, boolean> {
  const flags: Record<string, boolean> = {};

  for (const event of WEBHOOK_EVENTS) {
    flags[WEBHOOK_EVENT_KEYS[event]] = webhookAcceptsEvent(events, event);
  }

  return flags;
}
