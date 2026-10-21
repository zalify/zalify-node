import { randomUUID } from "node:crypto";
import { type HttpConfig, request } from "./http";

export type EventCustomer = {
  /** Your own id for the person (scoped to your workspace). */
  externalId?: string;
  email?: string;
  /** E.164, e.g. `+14155550123`. */
  phone?: string;
};

export type EventInput = {
  /**
   * The event name, e.g. `Quiz Completed` (1–64 characters, as written).
   * Names owned by an integration (`shopify_*`, `zalify.*`, …) are refused.
   * No registration needed: a new name shows up in the event catalog once
   * it arrives.
   */
  event: string;
  /**
   * Who did it: found by `externalId`, then `email`, then `phone`. Someone
   * new is created with no subscription or consent. At least one is needed.
   */
  customer: EventCustomer;
  /** Any JSON object (≤ 64 KB, ≤ 5 levels deep). Flows filter on it. */
  properties?: Record<string, unknown>;
  /** An amount the event carries, e.g. an order total. */
  value?: number;
  /** ISO 4217 code for `value`, e.g. `USD`. */
  valueCurrency?: string;
  /**
   * Your dedupe key: the same `uniqueId` is recorded once, however often
   * it's sent. Without one, the SDK's idempotency key plays that part for
   * its own retries.
   */
  uniqueId?: string;
  /**
   * When it happened (default: now). Up to 365 days back; events more than
   * 24 hours old are recorded but never start or end a flow.
   */
  time?: Date | string;
};

export type TrackEventResult = {
  id: string;
  profileId: string;
  /** The same event (same `uniqueId`) was recorded before; nothing new happened. */
  duplicate: boolean;
  /** More than 24 hours old: recorded, but no flow starts or ends on it. */
  recordedOnly: boolean;
};

export type TrackBatchItem =
  | {
      index: number;
      status: "accepted" | "duplicate";
      id: string;
      profileId: string;
      duplicate: boolean;
      recordedOnly: boolean;
    }
  | {
      index: number;
      status: "error";
      error: { code: string; message: string; field?: string };
    };

export type TrackBatchResult = {
  accepted: number;
  duplicates: number;
  failed: number;
  /** One per event, in request order. */
  results: TrackBatchItem[];
};

export type CatalogEventProperty = {
  /** JSON pointer into the event's properties, e.g. `/quiz/score`. */
  path: string;
  /** The type last seen; a hint only, flows choose their own comparison. */
  type: "string" | "number" | "boolean" | "date" | "list" | "object";
  label: { en: string; zh: string } | null;
  /** Your own events: when the key was last seen. */
  lastSeenAt: string | null;
};

export type CatalogEvent = {
  name: string;
  label: { en: string; zh: string } | null;
  /** The integration (`shopify`, `zalify`, …) or `custom` for your own events. */
  source: string;
  canTrigger: boolean;
  canExit: boolean;
  valuePath: string | null;
  properties: CatalogEventProperty[];
  available: boolean;
  /** e.g. `integration_not_connected`. */
  unavailableReason: string | null;
  lastSeenAt: string | null;
  eventCount: number | null;
};

export type EventCatalog = { events: CatalogEvent[] };

export type TrackOptions = {
  /**
   * Retrying with the same key records the event once (it becomes the
   * event's `uniqueId` when it has none; on a batch, `<key>:<index>`).
   * Defaults to a fresh UUID per call, so the SDK's own retries are safe.
   */
  idempotencyKey?: string;
};

const toBody = (input: EventInput) => ({
  ...input,
  ...(input.time instanceof Date ? { time: input.time.toISOString() } : {}),
});

export class Events {
  constructor(private readonly http: HttpConfig) {}

  /**
   * Record one event. Needs a key with Track events. Counts as one request
   * against the key's rate limit.
   */
  async track(
    input: EventInput,
    options: TrackOptions = {}
  ): Promise<TrackEventResult> {
    return request<TrackEventResult>(this.http, {
      method: "POST",
      path: "/events",
      body: toBody(input),
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  /**
   * Record up to 100 events in one request; each succeeds or fails on its
   * own (check `results`). The whole batch counts as one request against
   * the rate limit.
   */
  async trackBatch(
    inputs: EventInput[],
    options: TrackOptions = {}
  ): Promise<TrackBatchResult> {
    return request<TrackBatchResult>(this.http, {
      method: "POST",
      path: "/events/batch",
      body: { events: inputs.map(toBody) },
      idempotencyKey: options.idempotencyKey ?? randomUUID(),
    });
  }

  /** The events your flows can start, filter and exit on. */
  async catalog(): Promise<EventCatalog> {
    return request<EventCatalog>(this.http, {
      method: "GET",
      path: "/events/catalog",
    });
  }
}
