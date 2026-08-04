import type { Logger } from "../shared/logger.ts";
import { webhookAcceptsEvent } from "../shared/events.ts";
import { stringifyEvent, stripRawFromEvent } from "../shared/eventSerde.ts";
import type { NormalizedEvent, WebhookRecord } from "../shared/types.ts";
import { WebhookDeliveriesRepo } from "../storage/webhookDeliveriesRepo.ts";
import { WebhooksRepo } from "../storage/webhooksRepo.ts";
import { EventBus } from "./eventBus.ts";
import { EventPublisher } from "./eventPublisher.ts";

const MAX_RESPONSE_BODY = 2000;

function truncateResponseBody(value: string): string {
  return value.length > MAX_RESPONSE_BODY ? value.slice(0, MAX_RESPONSE_BODY) : value;
}

function computeRetryDelay(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 10_000);
}

export class WebhookDispatcher {
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly webhooksRepo: WebhooksRepo,
    private readonly deliveriesRepo: WebhookDeliveriesRepo,
    private readonly publisher: EventPublisher,
    private readonly logger: Logger
  ) {}

  start(eventBus: EventBus): void {
    if (this.unsubscribe) {
      return;
    }

    this.unsubscribe = eventBus.subscribe(null, (event) => {
      void this.dispatch(event);
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  listDeliveries(sessionId?: string) {
    return this.deliveriesRepo.list(sessionId);
  }

  private async dispatch(event: NormalizedEvent): Promise<void> {
    if (!event.sessionId || event.event.startsWith("webhook.")) {
      return;
    }

    const webhooks = this.webhooksRepo.list(event.sessionId);
    for (const webhook of webhooks) {
      if (!webhook.enabled) {
        continue;
      }

      if (!webhookAcceptsEvent(webhook.events, event.event)) {
        continue;
      }

      void this.deliver(webhook, event, 1);
    }
  }

  private async deliver(
    webhook: WebhookRecord,
    event: NormalizedEvent,
    attempt: number
  ): Promise<void> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), webhook.timeoutMs);

    let responseStatus: number | null = null;
    let responseBody: string | null = null;

    try {
      const response = await fetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: stringifyEvent(stripRawFromEvent(event)),
        signal: controller.signal
      });

      responseStatus = response.status;
      responseBody = truncateResponseBody(await response.text());

      if (!response.ok) {
        throw new Error(`Webhook respondeu ${response.status}`);
      }

      this.deliveriesRepo.create({
        webhookId: webhook.id,
        sessionId: webhook.sessionId,
        eventId: event.id,
        eventName: event.event,
        attempt,
        status: "delivered",
        httpStatus: responseStatus,
        error: null,
        responseBody
      });

      this.webhooksRepo.markAttemptResult(webhook.id, "delivered", null);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Falha desconhecida ao entregar webhook.";

      this.logger.warn("falha ao entregar webhook", {
        webhookId: webhook.id,
        sessionId: webhook.sessionId,
        attempt,
        error: message
      });

      this.deliveriesRepo.create({
        webhookId: webhook.id,
        sessionId: webhook.sessionId,
        eventId: event.id,
        eventName: event.event,
        attempt,
        status: "failed",
        httpStatus: responseStatus,
        error: message,
        responseBody
      });

      this.webhooksRepo.markAttemptResult(webhook.id, "failed", message);

      if (attempt < webhook.maxAttempts) {
        const delay = computeRetryDelay(attempt);
        setTimeout(() => {
          void this.deliver(webhook, event, attempt + 1);
        }, delay);
        return;
      }

      this.publisher.create("webhook.delivery_failed", webhook.sessionId, {
        webhookId: webhook.id,
        eventId: event.id,
        eventName: event.event,
        url: webhook.url,
        attempt,
        httpStatus: responseStatus,
        error: message
      });
    } finally {
      clearTimeout(timeout);
    }
  }
}
