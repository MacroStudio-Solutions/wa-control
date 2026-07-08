import { randomUUID } from "node:crypto";
import type { Logger } from "../shared/logger.ts";
import type { NormalizedEvent } from "../shared/types.ts";
import { nowUnix } from "../shared/utils.ts";
import { EventBus } from "./eventBus.ts";
import { EventsRepo } from "../storage/eventsRepo.ts";

export class EventPublisher {
  constructor(
    private readonly eventsRepo: EventsRepo,
    private readonly eventBus: EventBus,
    private readonly logger: Logger
  ) {}

  publish(event: NormalizedEvent): NormalizedEvent {
    this.eventsRepo.append(event);
    this.eventBus.publish(event);
    this.logger.info(`evento publicado: ${event.event}`, {
      sessionId: event.sessionId
    });
    return event;
  }

  create(
    eventName: string,
    sessionId: string | null,
    data: Record<string, unknown> = {}
  ): NormalizedEvent {
    return this.publish({
      id: randomUUID(),
      event: eventName,
      sessionId,
      timestamp: nowUnix(),
      ...data
    });
  }
}
