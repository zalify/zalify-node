import { ZalifyError } from "./errors";
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
   * it's sent. Without one, the API dedupes on the event's content (name,
   * person, time, properties); the SDK fixes `time` before the first
   * attempt so its own retries resend the same event.
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
  /**
   * The event was already recorded, by an earlier call or by an earlier
   * attempt of this one that the SDK retried. Either way it's recorded once.
   */
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
   * Optional. Retrying the whole call with the same key records each event
   * once: an event without a `uniqueId` takes the key as its dedupe key
   * (`<key>:<index>` on a batch). Use a new key for every call: reusing one
   * across different batches makes event N of each batch collide, and the
   * later ones come back as duplicates without being recorded. Prefer
   * `uniqueId` on the events themselves. At most 255 characters (251 on a
   * batch).
   */
  idempotencyKey?: string;
};

const MAX_IDEMPOTENCY_KEY = 255;

const invalid = (message: string, field?: string) =>
  new ZalifyError({ message, code: "invalid_request", status: 0, field });

/**
 * The event as sent. `time` is fixed here, once, before the first attempt
 * (now when not given), so a retry resends an identical body and the API's
 * content dedupe records the event once.
 */
const toBody = (input: EventInput, now: string, field = "time") => {
  let time: string;
  if (input.time === undefined) {
    time = now;
  } else if (input.time instanceof Date) {
    if (Number.isNaN(input.time.getTime())) {
      throw invalid("time is an invalid Date", field);
    }
    time = input.time.toISOString();
  } else {
    time = input.time;
  }
  return { ...input, time };
};

const checkKey = (key: string | undefined, max: number) => {
  if (key !== undefined && key.length > max) {
    throw invalid(`idempotencyKey must be ${max} characters or fewer`);
  }
};

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
    checkKey(options.idempotencyKey, MAX_IDEMPOTENCY_KEY);
    const body = toBody(input, new Date().toISOString());
    return request<TrackEventResult>(this.http, {
      method: "POST",
      path: "/events",
      body,
      idempotencyKey: options.idempotencyKey,
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
    checkKey(options.idempotencyKey, MAX_IDEMPOTENCY_KEY - 4);
    const now = new Date().toISOString();
    const events = inputs.map((input, index) =>
      toBody(input, now, `events.${index}.time`)
    );
    return request<TrackBatchResult>(this.http, {
      method: "POST",
      path: "/events/batch",
      body: { events },
      idempotencyKey: options.idempotencyKey,
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
