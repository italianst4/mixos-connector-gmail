/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { HttpConnector } from "@/lib/connectors/http-connector";
import type { ConnectorTestResult } from "@/lib/connectors/types";

/**
 * Gmail — read-only, one shared mailbox.
 *
 * **This is not per-user mail access.** Connectors on this platform are
 * tenant-scoped: an admin presses Connect once and every user of every app
 * reads that single mailbox. There is no way for this connector to reach an
 * individual user's own inbox, and it must not be presented as if it can.
 *
 * Design notes worth knowing before editing — the full reasoning, with links to
 * the base-layer code each one depends on, is in
 * `plans/20260826_2244-gmail-connector.md`:
 *
 *  - `access_type=offline&prompt=consent` rides in the manifest's
 *    `authorizeUrl` query string, because `buildAuthorizeUrl` only emits the
 *    standard OAuth params and Google withholds a refresh token without them.
 *  - `rateLimitOn403` is deliberately NOT declared: it would reclassify a
 *    missing-scope 403 as a retryable throttle, which is the most likely 403
 *    here. A real throttle carrying `Retry-After` still classifies correctly.
 *  - `listMessages` walks pages itself rather than using `this.paginate()`,
 *    because Gmail omits the `messages` key entirely on an empty result and
 *    `paginate()` would raise `unexpected_response` for an empty inbox.
 *    Retries, backoff and auth still come from `this.request()`.
 */

/** Gmail caps `maxResults` here; asking for more is silently truncated. */
const MAX_RESULTS_PER_PAGE = 500;
/** Hard stop on the page walk so a stuck `nextPageToken` cannot spin. */
const MAX_PAGES = 20;
/**
 * Hydrating a list costs one `messages.get` per message. Bounded and issued
 * sequentially so a widget cannot fan out against Gmail's per-user quota and
 * trip a 403 throttle that we intentionally do not retry.
 */
const MAX_HYDRATE = 25;
/** Depth guard on the MIME walk. Real mail nests two or three deep. */
const MAX_PART_DEPTH = 20;

// ── Upstream shapes ─────────────────────────────────────────────────────────

const Header = z.object({ name: z.string(), value: z.string() });

type RawPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: RawPart[];
};

const RawPart: z.ZodType<RawPart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(Header).optional(),
    body: z
      .object({
        attachmentId: z.string().optional(),
        size: z.number().optional(),
        data: z.string().optional(),
      })
      .optional(),
    parts: z.array(RawPart).optional(),
  }),
);

/** `payload` is absent for `format=minimal`, and body-less for `metadata`. */
const RawMessage = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  sizeEstimate: z.number().optional(),
  payload: RawPart.optional(),
});
type RawMessage = z.infer<typeof RawMessage>;

/**
 * `messages` is optional on purpose: Gmail returns `{"resultSizeEstimate": 0}`
 * with no `messages` key when a search matches nothing. Making this required
 * would turn an empty inbox into `unexpected_response`.
 */
const RawMessageList = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});

const RawThread = z.object({
  id: z.string(),
  historyId: z.string().optional(),
  messages: z.array(RawMessage).optional(),
});

const RawLabel = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  messagesTotal: z.number().optional(),
  messagesUnread: z.number().optional(),
});

const RawLabelList = z.object({ labels: z.array(RawLabel).optional() });

const RawAttachment = z.object({
  size: z.number().optional(),
  data: z.string().optional(),
});

const RawProfile = z.object({
  emailAddress: z.string().optional(),
  messagesTotal: z.number().optional(),
});

// ── What apps receive ───────────────────────────────────────────────────────

export type GmailLabel = z.infer<typeof RawLabel>;

/** What a list returns: Gmail gives ids only, never content. */
export interface GmailMessageRef {
  id: string;
  threadId: string;
}

export interface GmailMessagePage {
  messages: GmailMessageRef[];
  /** Pass back as `pageToken` to continue. Null when the walk is complete. */
  nextPageToken: string | null;
  /** Gmail's own estimate — approximate, and not a count of `messages`. */
  resultSizeEstimate: number;
}

export interface GmailAttachmentRef {
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds: string[];
  snippet: string;
  /** Epoch milliseconds as a string, exactly as Gmail sends it. */
  internalDate: string | null;
  sizeEstimate: number | null;
  /** Every header, keys lowercased. */
  headers: Record<string, string>;
  from: string | null;
  to: string | null;
  cc: string | null;
  subject: string | null;
  date: string | null;
  /** Decoded `text/plain` body, when the message has one. */
  text: string | null;
  /** Decoded `text/html` body, when the message has one. */
  html: string | null;
  /** Metadata only — fetch the bytes with `getAttachment`. */
  attachments: GmailAttachmentRef[];
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
}

export type GmailFormat = "full" | "metadata" | "minimal";

export interface GmailListOptions {
  /**
   * Gmail search syntax — `from:`, `subject:`, `is:unread`, `newer_than:7d`,
   * `has:attachment`, `label:`. Multiple labels are expressed here.
   */
  q?: string;
  /** Messages to return. Defaults to 25. */
  limit?: number;
  /** Continue a previous page. */
  pageToken?: string;
  /** Label IDs to intersect, e.g. `["INBOX", "UNREAD"]`. */
  labelIds?: string[];
  includeSpamTrash?: boolean;
}

export interface GmailSearchOptions extends GmailListOptions {
  /** Defaults to "full", which is what carries the message body. */
  format?: GmailFormat;
}

export default class GmailConnector extends HttpConnector {
  readonly name = "gmail";

  /**
   * The cheapest authenticated Gmail call. It proves the client credentials,
   * the grant, and the refresh path in one round trip — and the address it
   * reports is how an admin discovers they approved consent as themselves
   * rather than as the shared mailbox.
   */
  async testConnection(): Promise<ConnectorTestResult> {
    const me = await this.request("/gmail/v1/users/me/profile", undefined, {
      schema: RawProfile,
    });
    return {
      ok: true,
      detail: me?.emailAddress ? `Connected to ${me.emailAddress}` : undefined,
    };
  }

  /**
   * Search or list message ids. Cheap: one call per 500 messages.
   *
   * Gmail returns ids only — no headers, no body. Use `getMessage` for one
   * message, or `searchMessages` to list and read in a single call.
   */
  async listMessages(opts: GmailListOptions = {}): Promise<GmailMessagePage> {
    const limit = clamp(opts.limit ?? 25, 1, MAX_RESULTS_PER_PAGE * MAX_PAGES);
    const messages: GmailMessageRef[] = [];
    let pageToken: string | undefined = opts.pageToken;
    let resultSizeEstimate = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const remaining = limit - messages.length;
      if (remaining <= 0) break;

      const body = await this.request(this.messagesPath(opts.labelIds), undefined, {
        schema: RawMessageList,
        query: {
          q: opts.q,
          maxResults: Math.min(remaining, MAX_RESULTS_PER_PAGE),
          pageToken,
          includeSpamTrash: opts.includeSpamTrash,
        },
      });
      if (!body) break;

      resultSizeEstimate = body.resultSizeEstimate ?? resultSizeEstimate;
      // Absent rather than empty when nothing matched — not an error.
      messages.push(...(body.messages ?? []));

      pageToken = body.nextPageToken;
      if (!pageToken) break;
    }

    return {
      messages: messages.slice(0, limit),
      nextPageToken: pageToken ?? null,
      resultSizeEstimate,
    };
  }

  /**
   * List and read in one call: the common case for rendering an inbox.
   *
   * Costs one call per message on top of the list, so it is capped at
   * MAX_HYDRATE (25) and the reads are sequential. For more than that, page
   * through `listMessages` and call `getMessage` at a rate you control.
   */
  async searchMessages(opts: GmailSearchOptions = {}): Promise<GmailMessage[]> {
    const limit = clamp(opts.limit ?? 10, 1, MAX_HYDRATE);
    const page = await this.listMessages({ ...opts, limit });

    const out: GmailMessage[] = [];
    for (const ref of page.messages) {
      const message = await this.getMessage(ref.id, { format: opts.format });
      if (message) out.push(message);
    }
    return out;
  }

  /**
   * One message, with its MIME tree walked and the body decoded.
   *
   * `format` is "full" (headers plus body), "metadata" (headers only, no body)
   * or "minimal" (labels and snippet only).
   */
  async getMessage(
    id: string,
    opts: { format?: GmailFormat } = {},
  ): Promise<GmailMessage | null> {
    const raw = await this.request(
      `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`,
      undefined,
      { schema: RawMessage, query: { format: opts.format ?? "full" } },
    );
    return raw ? shapeMessage(raw) : null;
  }

  /** A whole conversation, oldest first, each message decoded as above. */
  async getThread(
    id: string,
    opts: { format?: GmailFormat } = {},
  ): Promise<GmailThread | null> {
    const raw = await this.request(
      `/gmail/v1/users/me/threads/${encodeURIComponent(id)}`,
      undefined,
      { schema: RawThread, query: { format: opts.format ?? "full" } },
    );
    if (!raw) return null;
    return { id: raw.id, messages: (raw.messages ?? []).map(shapeMessage) };
  }

  /** Every label, so callers can turn the ids on a message into names. */
  async listLabels(): Promise<GmailLabel[]> {
    const body = await this.request("/gmail/v1/users/me/labels", undefined, {
      schema: RawLabelList,
    });
    return body?.labels ?? [];
  }

  /**
   * Attachment bytes, decoded from Gmail's base64url envelope.
   *
   * Gmail returns these inside a JSON body, so base64 inflates them by 4/3
   * against the manifest's 20 MiB `maxResponseBytes` — an attachment much over
   * ~15 MB raises `payload_too_large` rather than being truncated.
   */
  async getAttachment(
    messageId: string,
    attachmentId: string,
  ): Promise<{ size: number; data: Buffer } | null> {
    const body = await this.request(
      `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}` +
        `/attachments/${encodeURIComponent(attachmentId)}`,
      undefined,
      { schema: RawAttachment },
    );
    if (!body?.data) return null;
    const bytes = Buffer.from(body.data, "base64url");
    return { size: body.size ?? bytes.byteLength, data: bytes };
  }

  /**
   * Gmail takes `labelIds` as a repeated query parameter, which
   * `RequestOptions.query` cannot express — it is a record applied with
   * `searchParams.set()`. Building them into the path works because
   * `resolveUrl` parses it with `new URL()`, which preserves an existing query
   * string before the other parameters are set on top.
   */
  private messagesPath(labelIds?: string[]): string {
    const base = "/gmail/v1/users/me/messages";
    if (!labelIds?.length) return base;
    const repeated = labelIds
      .map((id) => `labelIds=${encodeURIComponent(id)}`)
      .join("&");
    return `${base}?${repeated}`;
  }
}

// ── Decoding ────────────────────────────────────────────────────────────────

function shapeMessage(raw: RawMessage): GmailMessage {
  const headers = headerMap(raw.payload?.headers);
  const parts = collect(raw.payload);

  return {
    id: raw.id,
    threadId: raw.threadId,
    labelIds: raw.labelIds ?? [],
    snippet: raw.snippet ?? "",
    internalDate: raw.internalDate ?? null,
    sizeEstimate: raw.sizeEstimate ?? null,
    headers,
    from: headers.from ?? null,
    to: headers.to ?? null,
    cc: headers.cc ?? null,
    subject: headers.subject ?? null,
    date: headers.date ?? null,
    text: parts.text,
    html: parts.html,
    attachments: parts.attachments,
  };
}

interface Collected {
  text: string | null;
  html: string | null;
  attachments: GmailAttachmentRef[];
}

/**
 * Walk Gmail's MIME part tree, taking the first `text/plain` and `text/html`
 * bodies and the metadata of anything with an attachment id.
 *
 * A multipart message carries its content in nested `parts`; a plain one
 * carries it directly on `payload`. Both land here.
 */
function collect(payload: RawPart | undefined): Collected {
  const acc: Collected = { text: null, html: null, attachments: [] };
  if (payload) walk(payload, acc, 0);
  return acc;
}

function walk(part: RawPart, acc: Collected, depth: number): void {
  if (depth > MAX_PART_DEPTH) return;

  const mimeType = part.mimeType ?? "";
  const { attachmentId, data, size } = part.body ?? {};

  if (attachmentId) {
    acc.attachments.push({
      attachmentId,
      filename: part.filename ?? "",
      mimeType: mimeType || "application/octet-stream",
      size: size ?? 0,
    });
  } else if (data) {
    if (mimeType === "text/plain" && acc.text === null) acc.text = decode(data);
    else if (mimeType === "text/html" && acc.html === null) acc.html = decode(data);
  }

  for (const child of part.parts ?? []) walk(child, acc, depth + 1);
}

/** Gmail encodes bodies with the URL-safe base64 alphabet. */
function decode(data: string): string {
  return Buffer.from(data, "base64url").toString("utf-8");
}

/**
 * Header names are case-insensitive per RFC 5322, so callers should not have to
 * guess whether the sender wrote `Message-ID` or `Message-Id`. Null-prototype
 * because the keys come from the message and a header named `__proto__` should
 * be a lookup, not a surprise.
 */
function headerMap(headers?: { name: string; value: string }[]): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const header of headers ?? []) out[header.name.toLowerCase()] = header.value;
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
