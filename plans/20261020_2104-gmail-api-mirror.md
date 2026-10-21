# Gmail 1.0.0: mirror the Gmail API

## Context

MixOS now holds connectors to a contract (mixoshq/mixos#73,
`docs/plans/20261020_0728-connector-contracts.md` in the core): a connector
mirrors its provider's API, one method per operation, each naming the operation
it calls; it returns what the provider returns; it has a `version` and only adds
within a major version; and its writes ship off, for an admin to allow per
install. The first version of this connector predates that. It had six reads,
one of which, `searchMessages`, combined two operations, and `getMessage`
returned a shape of its own that kept a message's first text and HTML bodies
and dropped the rest of its MIME tree.

This brings it to the contract, as its first versioned release, 1.0.0.

## Decisions

- **Coverage: every operation on the resources it touches.** `users.getProfile`,
  `users.messages` with `users.messages.attachments`, `users.threads` and
  `users.labels`. Twenty-two methods, each named after its operation.
- **Left out on purpose, and said so in the class and the README:**
  - `users.messages.delete`, `users.messages.batchDelete` and
    `users.threads.delete` delete permanently, bypassing Trash, and need full
    access to the mailbox, `https://mail.google.com/`. Trash and untrash are
    here, under `gmail.modify`.
  - `users.watch` and `users.stop` push changes through a Cloud Pub/Sub topic,
    whose deliveries are verified with Google-signed tokens that the platform's
    webhooks don't check.
- **Google's resources, whole.** A message is Google's `Message`, payload tree
  and all, typed with `z.looseObject` so a field the schema doesn't name still
  arrives. It also carries `decoded`: its headers, its first `text/plain` and
  `text/html` bodies, and its attachments, read from the tree the connector
  leaves in place. Every consumer needs that decoding, and keeping the tree
  beside it loses nothing. Lists are Google's list responses. An attachment is
  Google's `MessagePartBody`, with its bytes decoded beside the base64url data.
- **`searchMessages` goes.** It listed and then read each message: two
  operations in one method. An app lists with `listMessages` and reads with
  `getMessage`, at a pace it chooses.
- **A list is one page, as the operation is.** `listMessages` and
  `listThreads` take Google's `maxResults` and `pageToken` and return Google's
  page. The walk that took a `limit` and followed `nextPageToken` goes: how
  far to read is the app's call.
- **Writes ship off.** The fourteen methods that change the mailbox are declared
  `mutates`, and need `gmail.modify`, which the manifest requests with
  `"write"`. Reads need only `gmail.readonly`, always requested.
- **Retries follow what repeating does.** Modify, trash, untrash, batch modify,
  label patch and update land the same however often they run, and are retried.
  Send, insert and import are not: each run adds the message again. Nor is label
  create, whose repeat would fail on the name it had just taken.
- **Unchanged:** tenant-scoped three-legged OAuth, the profile probe in
  `testConnection()`, and no `rateLimitOn403`, for the reasons in
  `20260826_2244-gmail-connector.md`.

## Structure

| Method | Operation | Changes data |
| --- | --- | --- |
| `getProfile` | `users.getProfile` | |
| `listMessages` | `users.messages.list` | |
| `getMessage` | `users.messages.get` | |
| `getAttachment` | `users.messages.attachments.get` | |
| `sendMessage` | `users.messages.send` | yes |
| `insertMessage` | `users.messages.insert` | yes |
| `importMessage` | `users.messages.import` | yes |
| `modifyMessage` | `users.messages.modify` | yes |
| `batchModifyMessages` | `users.messages.batchModify` | yes |
| `trashMessage` | `users.messages.trash` | yes |
| `untrashMessage` | `users.messages.untrash` | yes |
| `listThreads` | `users.threads.list` | |
| `getThread` | `users.threads.get` | |
| `modifyThread` | `users.threads.modify` | yes |
| `trashThread` | `users.threads.trash` | yes |
| `untrashThread` | `users.threads.untrash` | yes |
| `listLabels` | `users.labels.list` | |
| `getLabel` | `users.labels.get` | |
| `createLabel` | `users.labels.create` | yes |
| `updateLabel` | `users.labels.update` | yes |
| `patchLabel` | `users.labels.patch` | yes |
| `deleteLabel` | `users.labels.delete` | yes |

Inbox Actions, the one app using it, declares `{ "name": "gmail", "version":
"1.0.0" }`, reads only, and maps a message from its `decoded` view.

Needs MixOS 0.4.0 or later: an older MixOS refuses a `connector.json` with a
`version`.

## Verification

1. In a MixOS checkout at 0.4.0 or later, with this repository at
   `connectors/gmail`: `npm run registry`, `npm run typecheck`,
   `npm run verify:connectors`.
2. `npx tsx scripts/check-scopes.ts gmail`: `gmail.readonly` requested,
   `gmail.modify` requested once changes are allowed.
3. Connector Registry, as an admin: Connect asks for read-only access, and adds
   `gmail.modify` once changes are allowed and it is connected again.
