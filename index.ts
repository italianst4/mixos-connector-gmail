/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { z } from "zod";
import { HttpConnector } from "@/lib/connectors/http-connector";
import type { ConnectorTestResult } from "@/lib/connectors/types";

/**
 * Gmail: the Gmail API v1's profile, messages, attachments, threads and
 * labels, for one shared mailbox.
 *
 * It mirrors the API. One method per operation, named after it, taking the
 * operation's own parameters and returning its own resource, typed, with every
 * field Google sends. Apps compose these; nothing here is shaped for one app.
 * `operation` in connector.json names the API method each one calls.
 *
 * Reads need `gmail.readonly`, which is always requested. The methods declared
 * `mutates` need `gmail.modify`, which the manifest requests with "write":
 * asked for at Connect only once an admin has allowed this connector to change
 * data. Until then the platform refuses those methods before they run, and the
 * grant doesn't hold the scope either.
 *
 * Left out on purpose:
 *
 *  - `users.messages.delete`, `users.messages.batchDelete` and
 *    `users.threads.delete`. They delete for good, skipping Trash, and need
 *    full access to the mailbox, `https://mail.google.com/`. Trash and untrash
 *    are here.
 *  - `users.watch` and `users.stop`. They push changes through a Cloud Pub/Sub
 *    topic, whose deliveries carry Google-signed tokens that the platform's
 *    webhooks don't verify.
 *
 * **This is not per-user mail access.** Connectors on this platform are
 * tenant-scoped: an admin presses Connect once and every user of every app
 * reaches that single mailbox. There is no way for this connector to reach an
 * individual user's own inbox, and it must not be presented as if it can.
 *
 * Design notes worth knowing before editing — the reasoning is in `plans/`:
 *
 *  - `access_type=offline&prompt=consent` rides in the manifest's
 *    `authorizeUrl` query string, because `buildAuthorizeUrl` only emits the
 *    standard OAuth params and Google withholds a refresh token without them.
 *  - `rateLimitOn403` is deliberately NOT declared: it would reclassify a
 *    missing-scope 403 as a retryable throttle, which is the most likely 403
 *    here. A real throttle carrying `Retry-After` still classifies correctly.
 *  - A message comes back as Google's `Message`, its MIME tree intact, with
 *    `decoded` beside it: its headers, its first text and HTML bodies, and its
 *    attachments, read from that tree. Every caller would otherwise repeat the
 *    base64url and MIME walk, and the tree stays for anything it skips.
 *  - Retries follow what repeating does. A modify, a trash or untrash, and a
 *    label update or patch land the same however often they run, and are
 *    retried. A send, an insert and an import are not, since each run adds the
 *    message again, and nor is a label create, whose repeat would fail on the
 *    name it had just taken.
 */

/** Depth guard on the MIME walk. Real mail nests two or three deep. */
const MAX_PART_DEPTH = 20;

// ── Google's resources ──────────────────────────────────────────────────────
//
// Each declares the fields Google documents, as `looseObject`, so every field
// it doesn't name still reaches the app. See the Gmail API reference:
// https://developers.google.com/workspace/gmail/api/reference/rest

const MessagePartHeaderSchema = z.looseObject({
  name: z.string(),
  value: z.string(),
});
export type MessagePartHeader = z.infer<typeof MessagePartHeaderSchema>;

/** A part's content, base64url in `data`, or where to fetch it: `attachmentId`. */
const MessagePartBodySchema = z.looseObject({
  attachmentId: z.string().optional(),
  /** Bytes in the part, before base64url. */
  size: z.number().optional(),
  data: z.string().optional(),
});
export type MessagePartBody = z.infer<typeof MessagePartBodySchema>;

/** One node of a message's MIME tree. A multipart part holds the rest in `parts`. */
const MessagePartSchema = z.looseObject({
  partId: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
  headers: z.array(MessagePartHeaderSchema).optional(),
  body: MessagePartBodySchema.optional(),
  get parts(): z.ZodOptional<z.ZodArray<typeof MessagePartSchema>> {
    return z.array(MessagePartSchema).optional();
  },
});
export type MessagePart = z.infer<typeof MessagePartSchema>;

/**
 * A message. Which fields arrive depends on `format`: `payload` is absent for
 * "minimal" and "raw" and has no bodies for "metadata", and `raw` comes only
 * with "raw". A write answers with `id`, `threadId` and `labelIds`.
 */
const MessageSchema = z.looseObject({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
  /** When Gmail received it: epoch milliseconds, as a string. */
  internalDate: z.string().optional(),
  sizeEstimate: z.number().optional(),
  payload: MessagePartSchema.optional(),
  /** The whole RFC 2822 message, base64url-encoded. */
  raw: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

/** A message as a list names it. Read it with `getMessage`. */
const MessageRefSchema = z.looseObject({
  id: z.string(),
  threadId: z.string(),
});
export type MessageRef = z.infer<typeof MessageRefSchema>;

/**
 * One page of messages. Gmail leaves `messages` out, rather than sending an
 * empty list, when nothing matched.
 */
const ListMessagesResponseSchema = z.looseObject({
  messages: z.array(MessageRefSchema).optional(),
  nextPageToken: z.string().optional(),
  /** Gmail's estimate of all the matches, not a count of this page. */
  resultSizeEstimate: z.number().optional(),
});
export type ListMessagesResponse = z.infer<typeof ListMessagesResponseSchema>;

/** A thread as a list names it. `getThread` adds its messages. */
const ThreadSchema = z.looseObject({
  id: z.string(),
  snippet: z.string().optional(),
  historyId: z.string().optional(),
});
export type Thread = z.infer<typeof ThreadSchema>;

const ThreadWithMessagesSchema = z.looseObject({
  ...ThreadSchema.shape,
  /** Oldest first. */
  messages: z.array(MessageSchema).optional(),
});

/** One page of threads. `threads` is left out when nothing matched. */
const ListThreadsResponseSchema = z.looseObject({
  threads: z.array(ThreadSchema).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});
export type ListThreadsResponse = z.infer<typeof ListThreadsResponseSchema>;

const LabelColorSchema = z.looseObject({
  textColor: z.string().optional(),
  backgroundColor: z.string().optional(),
});

/**
 * A label. `type` is "system" for Gmail's own, such as INBOX and UNREAD, and
 * "user" for the mailbox's. Only `getLabel` sends the counts.
 */
const LabelSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  type: z.string().optional(),
  messageListVisibility: z.string().optional(),
  labelListVisibility: z.string().optional(),
  messagesTotal: z.number().optional(),
  messagesUnread: z.number().optional(),
  threadsTotal: z.number().optional(),
  threadsUnread: z.number().optional(),
  color: LabelColorSchema.optional(),
});
export type Label = z.infer<typeof LabelSchema>;

const ListLabelsResponseSchema = z.looseObject({
  labels: z.array(LabelSchema).optional(),
});
export type ListLabelsResponse = z.infer<typeof ListLabelsResponseSchema>;

/** The connected mailbox. */
const ProfileSchema = z.looseObject({
  emailAddress: z.string(),
  messagesTotal: z.number().optional(),
  threadsTotal: z.number().optional(),
  historyId: z.string().optional(),
});
export type Profile = z.infer<typeof ProfileSchema>;

// ── What a message adds ─────────────────────────────────────────────────────

/** A part with an attachment id. Fetch its bytes with `getAttachment`. */
export interface AttachmentPart {
  /** Stable for the message, where `attachmentId` can change between reads. */
  partId?: string;
  attachmentId: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** A message's MIME tree, read. Empty for a format that has none. */
export interface DecodedMessage {
  /** The message's headers, names lowercased: `decoded.headers.subject`. */
  headers: Record<string, string>;
  /** The first `text/plain` body, decoded, or null. */
  text: string | null;
  /** The first `text/html` body, decoded, or null. */
  html: string | null;
  attachments: AttachmentPart[];
}

/** Google's `Message`, with `decoded` beside its MIME tree. */
export type GmailMessage = Message & { decoded: DecodedMessage };

/** Google's `Thread`, each of its messages a `GmailMessage`. */
export type GmailThread = Thread & { messages?: GmailMessage[] };

/** Google's `MessagePartBody` for an attachment, with its bytes decoded. */
export type GmailAttachment = MessagePartBody & { bytes: Buffer };

// ── What the methods take ───────────────────────────────────────────────────

/** The parameters `users.messages.list` and `users.threads.list` share. */
export interface ListOptions {
  /** Gmail search syntax, as in its search box: `from:`, `is:unread`, `newer_than:7d`. */
  q?: string;
  /** How many per page. Gmail's default is 100, and its most 500. */
  maxResults?: number;
  /** The `nextPageToken` of the page before. */
  pageToken?: string;
  /** Only those with every one of these labels. */
  labelIds?: readonly string[];
  /** Include Spam and Trash too. */
  includeSpamTrash?: boolean;
}

export interface GetMessageOptions {
  /**
   * "full", Gmail's default: headers and bodies, as the MIME tree. "metadata":
   * headers only. "minimal": ids and labels. "raw": the whole message, as
   * base64url in `raw`.
   */
  format?: "full" | "metadata" | "minimal" | "raw";
  /** With "metadata", only these headers. */
  metadataHeaders?: readonly string[];
}

export interface GetThreadOptions {
  /** As for `getMessage`, without "raw". */
  format?: "full" | "metadata" | "minimal";
  metadataHeaders?: readonly string[];
}

/** Labels to add and remove. Archiving removes INBOX; marking read removes UNREAD. */
export interface LabelChanges {
  addLabelIds?: readonly string[];
  removeLabelIds?: readonly string[];
}

/** A message to add to the mailbox: RFC 2822, base64url-encoded, in `raw`. */
export interface MessageInput {
  raw: string;
  labelIds?: readonly string[];
  /** The thread to add it to. Its Subject and References must match the thread's. */
  threadId?: string;
}

export interface InsertMessageOptions {
  /** Where its internal date comes from. Gmail's default is "receivedTime". */
  internalDateSource?: "receivedTime" | "dateHeader";
  /** Mark it deleted, so only Google Vault sees it. Google Workspace only. */
  deleted?: boolean;
}

export interface ImportMessageOptions {
  /** Where its internal date comes from. Gmail's default is "dateHeader". */
  internalDateSource?: "receivedTime" | "dateHeader";
  /** Never classify it as spam. */
  neverMarkSpam?: boolean;
  /** Add any calendar invitations in it to the calendar. */
  processForCalendar?: boolean;
  /** Mark it deleted, so only Google Vault sees it. Google Workspace only. */
  deleted?: boolean;
}

/** A label's name, and where Gmail shows it. */
export interface LabelInput {
  name: string;
  /** In the message list. */
  messageListVisibility?: "show" | "hide";
  /** In the label list. */
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  /** Hex colors from Gmail's palette, such as "#000000". */
  color?: { textColor?: string; backgroundColor?: string };
}

const ME = "/gmail/v1/users/me";
const messagePath = (id: string) => `${ME}/messages/${encodeURIComponent(id)}`;
const threadPath = (id: string) => `${ME}/threads/${encodeURIComponent(id)}`;
const labelPath = (id: string) => `${ME}/labels/${encodeURIComponent(id)}`;

/** A JSON body, for a POST unless said otherwise. */
const json = (body: unknown, method = "POST"): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** A POST with no body, as trash and untrash take. */
const EMPTY_POST: RequestInit = { method: "POST" };

const listQuery = (opts: ListOptions) => ({
  q: opts.q,
  maxResults: opts.maxResults,
  pageToken: opts.pageToken,
  labelIds: opts.labelIds,
  includeSpamTrash: opts.includeSpamTrash,
});

export default class GmailConnector extends HttpConnector {
  readonly name = "gmail";

  /**
   * The cheapest authenticated Gmail call. It proves the client credentials,
   * the grant, and the refresh path in one round trip — and the address it
   * reports is how an admin discovers they approved consent as themselves
   * rather than as the shared mailbox.
   */
  async testConnection(): Promise<ConnectorTestResult> {
    const profile = await this.requestBody(`${ME}/profile`, undefined, {
      schema: ProfileSchema,
    });
    return { ok: true, detail: `Connected to ${profile.emailAddress}` };
  }

  /** `users.getProfile`: the connected mailbox's address and totals. */
  async getProfile(): Promise<Profile> {
    return this.requestBody(`${ME}/profile`, undefined, { schema: ProfileSchema });
  }

  // ── users.messages ───────────────────────────────────────────────────────

  /**
   * `users.messages.list`: one page of message ids, newest first. Gmail sends
   * ids only; read each with `getMessage`, at a pace its quota allows.
   */
  async listMessages(opts: ListOptions = {}): Promise<ListMessagesResponse> {
    return this.requestBody(`${ME}/messages`, undefined, {
      schema: ListMessagesResponseSchema,
      query: listQuery(opts),
    });
  }

  /** `users.messages.get`: one message, the whole of it unless `format` asks for less. */
  async getMessage(id: string, opts: GetMessageOptions = {}): Promise<GmailMessage> {
    const message = await this.requestBody(messagePath(id), undefined, {
      schema: MessageSchema,
      query: { format: opts.format, metadataHeaders: opts.metadataHeaders },
    });
    return decodeMessage(message);
  }

  /**
   * `users.messages.attachments.get`: an attachment's content, its id from the
   * message's `decoded.attachments`.
   *
   * Google sends the bytes as base64url inside JSON, a third larger than the
   * file, against the manifest's 20 MiB `maxResponseBytes`: an attachment much
   * over 15 MB fails as `payload_too_large` rather than arriving cut short.
   */
  async getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachment> {
    const body = await this.requestBody(
      `${messagePath(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      undefined,
      { schema: MessagePartBodySchema },
    );
    return { ...body, bytes: Buffer.from(body.data ?? "", "base64url") };
  }

  /**
   * `users.messages.send`: sends `raw`, an RFC 2822 message base64url-encoded,
   * from the connected mailbox to the recipients in its To, Cc and Bcc headers.
   */
  async sendMessage(message: { raw: string; threadId?: string }): Promise<GmailMessage> {
    const sent = await this.requestBody(`${ME}/messages/send`, json(message), {
      schema: MessageSchema,
    });
    return decodeMessage(sent);
  }

  /**
   * `users.messages.insert`: adds a message straight to the mailbox, as IMAP
   * APPEND does, skipping most scanning and classification. It sends nothing.
   */
  async insertMessage(
    message: MessageInput,
    opts: InsertMessageOptions = {},
  ): Promise<GmailMessage> {
    const inserted = await this.requestBody(`${ME}/messages`, json(message), {
      schema: MessageSchema,
      query: { internalDateSource: opts.internalDateSource, deleted: opts.deleted },
    });
    return decodeMessage(inserted);
  }

  /**
   * `users.messages.import`: adds a message to the mailbox as if it had
   * arrived by email, scanned and classified. It sends nothing.
   */
  async importMessage(
    message: MessageInput,
    opts: ImportMessageOptions = {},
  ): Promise<GmailMessage> {
    const imported = await this.requestBody(`${ME}/messages/import`, json(message), {
      schema: MessageSchema,
      query: {
        internalDateSource: opts.internalDateSource,
        neverMarkSpam: opts.neverMarkSpam,
        processForCalendar: opts.processForCalendar,
        deleted: opts.deleted,
      },
    });
    return decodeMessage(imported);
  }

  /** `users.messages.modify`: adds and removes labels on one message. */
  async modifyMessage(id: string, changes: LabelChanges): Promise<GmailMessage> {
    const modified = await this.requestBody(`${messagePath(id)}/modify`, json(changes), {
      schema: MessageSchema,
      idempotent: true,
    });
    return decodeMessage(modified);
  }

  /** `users.messages.batchModify`: the same label changes on up to 1,000 messages. */
  async batchModifyMessages(
    request: { ids: readonly string[] } & LabelChanges,
  ): Promise<void> {
    await this.request(`${ME}/messages/batchModify`, json(request), { idempotent: true });
  }

  /** `users.messages.trash`: moves a message to Trash, which Gmail empties after 30 days. */
  async trashMessage(id: string): Promise<GmailMessage> {
    const trashed = await this.requestBody(`${messagePath(id)}/trash`, EMPTY_POST, {
      schema: MessageSchema,
      idempotent: true,
    });
    return decodeMessage(trashed);
  }

  /** `users.messages.untrash`: takes a message back out of Trash. */
  async untrashMessage(id: string): Promise<GmailMessage> {
    const untrashed = await this.requestBody(`${messagePath(id)}/untrash`, EMPTY_POST, {
      schema: MessageSchema,
      idempotent: true,
    });
    return decodeMessage(untrashed);
  }

  // ── users.threads ────────────────────────────────────────────────────────

  /** `users.threads.list`: one page of threads, newest first, with their snippets. */
  async listThreads(opts: ListOptions = {}): Promise<ListThreadsResponse> {
    return this.requestBody(`${ME}/threads`, undefined, {
      schema: ListThreadsResponseSchema,
      query: listQuery(opts),
    });
  }

  /** `users.threads.get`: a conversation, its messages oldest first. */
  async getThread(id: string, opts: GetThreadOptions = {}): Promise<GmailThread> {
    const thread = await this.requestBody(threadPath(id), undefined, {
      schema: ThreadWithMessagesSchema,
      query: { format: opts.format, metadataHeaders: opts.metadataHeaders },
    });
    return decodeThread(thread);
  }

  /** `users.threads.modify`: adds and removes labels on every message in a thread. */
  async modifyThread(id: string, changes: LabelChanges): Promise<GmailThread> {
    const modified = await this.requestBody(`${threadPath(id)}/modify`, json(changes), {
      schema: ThreadWithMessagesSchema,
      idempotent: true,
    });
    return decodeThread(modified);
  }

  /** `users.threads.trash`: moves a whole thread to Trash. */
  async trashThread(id: string): Promise<GmailThread> {
    const trashed = await this.requestBody(`${threadPath(id)}/trash`, EMPTY_POST, {
      schema: ThreadWithMessagesSchema,
      idempotent: true,
    });
    return decodeThread(trashed);
  }

  /** `users.threads.untrash`: takes a whole thread back out of Trash. */
  async untrashThread(id: string): Promise<GmailThread> {
    const untrashed = await this.requestBody(`${threadPath(id)}/untrash`, EMPTY_POST, {
      schema: ThreadWithMessagesSchema,
      idempotent: true,
    });
    return decodeThread(untrashed);
  }

  // ── users.labels ─────────────────────────────────────────────────────────

  /** `users.labels.list`: every label, Gmail's own and the mailbox's, without counts. */
  async listLabels(): Promise<ListLabelsResponse> {
    return this.requestBody(`${ME}/labels`, undefined, { schema: ListLabelsResponseSchema });
  }

  /** `users.labels.get`: one label, with its message and thread counts. */
  async getLabel(id: string): Promise<Label> {
    return this.requestBody(labelPath(id), undefined, { schema: LabelSchema });
  }

  /** `users.labels.create`: a new label. Gmail refuses a name already taken. */
  async createLabel(label: LabelInput): Promise<Label> {
    return this.requestBody(`${ME}/labels`, json(label), { schema: LabelSchema });
  }

  /** `users.labels.update`: replaces a label's name, visibility and color. */
  async updateLabel(id: string, label: LabelInput): Promise<Label> {
    return this.requestBody(labelPath(id), json({ ...label, id }, "PUT"), {
      schema: LabelSchema,
    });
  }

  /** `users.labels.patch`: changes only the fields given. */
  async patchLabel(id: string, label: Partial<LabelInput>): Promise<Label> {
    return this.requestBody(labelPath(id), json({ ...label, id }, "PATCH"), {
      schema: LabelSchema,
      idempotent: true,
    });
  }

  /**
   * `users.labels.delete`: deletes a label for good, taking it off every
   * message and thread that has it. The messages stay.
   */
  async deleteLabel(id: string): Promise<void> {
    await this.request(labelPath(id), { method: "DELETE" });
  }
}

// ── Decoding ────────────────────────────────────────────────────────────────

function decodeMessage(message: Message): GmailMessage {
  const decoded: DecodedMessage = {
    headers: headerMap(message.payload?.headers),
    text: null,
    html: null,
    attachments: [],
  };
  if (message.payload) walk(message.payload, decoded, 0);
  return { ...message, decoded };
}

function decodeThread(thread: z.infer<typeof ThreadWithMessagesSchema>): GmailThread {
  return { ...thread, messages: thread.messages?.map(decodeMessage) };
}

/**
 * Walk Gmail's MIME part tree, taking the first `text/plain` and `text/html`
 * bodies and every part with an attachment id.
 *
 * A multipart message carries its content in nested `parts`; a plain one
 * carries it directly on `payload`. Both land here.
 */
function walk(part: MessagePart, decoded: DecodedMessage, depth: number): void {
  if (depth > MAX_PART_DEPTH) return;

  const mimeType = part.mimeType ?? "";
  const { attachmentId, data, size } = part.body ?? {};

  if (attachmentId) {
    decoded.attachments.push({
      partId: part.partId,
      attachmentId,
      filename: part.filename ?? "",
      mimeType: mimeType || "application/octet-stream",
      size: size ?? 0,
    });
  } else if (data) {
    if (mimeType === "text/plain" && decoded.text === null) decoded.text = decode(data);
    else if (mimeType === "text/html" && decoded.html === null) decoded.html = decode(data);
  }

  for (const child of part.parts ?? []) walk(child, decoded, depth + 1);
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
function headerMap(headers?: MessagePartHeader[]): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const header of headers ?? []) out[header.name.toLowerCase()] = header.value;
  return out;
}
