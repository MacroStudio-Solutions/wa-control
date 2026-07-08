import type { NormalizedEvent } from "../shared/types.ts";

type EventListener = (event: NormalizedEvent) => void;

export class EventBus {
  private readonly listeners = new Set<{
    filterSessionId: string | null;
    listener: EventListener;
  }>();

  subscribe(filterSessionId: string | null, listener: EventListener): () => void {
    const entry = { filterSessionId, listener };
    this.listeners.add(entry);

    return () => {
      this.listeners.delete(entry);
    };
  }

  publish(event: NormalizedEvent): void {
    for (const { filterSessionId, listener } of this.listeners) {
      if (filterSessionId && filterSessionId !== event.sessionId) {
        continue;
      }

      listener(event);
    }
  }
}
