import { type HttpConfig, request } from "./http";

export type UpsertContactParams = {
  /** The contact is found by this address (case-insensitive) or created. */
  email: string;
  /** E.164, e.g. `+14155550123`. Left off if another contact has it. */
  phone?: string;
  firstName?: string;
  lastName?: string;
  /** Custom fields, merged into the existing ones (≤ 100 keys, 16 KB). */
  properties?: Record<string, unknown>;
  /**
   * Email marketing consent: `true` subscribes (ending an earlier
   * unsubscribe), `false` unsubscribes, omitted leaves it unchanged. Send
   * `true` only for people who opted in.
   */
  subscribed?: boolean;
  /** Ids of your workspace's lists to add the contact to (≤ 20). */
  lists?: string[];
};

export type UpsertContactResult = {
  id: string;
  /** As stored (lowercased). */
  email: string;
  /** Subscribed to email marketing after this call. */
  subscribed: boolean;
  lists: Array<{ id: string; status: "joined" | "already_member" }>;
  /** True when the phone belongs to another contact and wasn't attached. */
  phoneSkipped?: boolean;
};

export class Contacts {
  constructor(private readonly http: HttpConfig) {}

  /**
   * Create or update one contact by email. Safe to retry: the same email
   * always updates the same contact. Needs a key with Manage contacts.
   */
  async upsert(params: UpsertContactParams): Promise<UpsertContactResult> {
    return request<UpsertContactResult>(this.http, {
      method: "POST",
      path: "/contacts",
      body: params,
    });
  }
}
