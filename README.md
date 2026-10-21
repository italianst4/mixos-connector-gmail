# Gmail

One shared Gmail mailbox for the apps in your workspace. They can search and
read its mail and, once you allow it, send, label and trash it.

## What it can reach

The Gmail API's profile, messages and attachments, threads and labels: one
method for each of Google's operations, returning what Google returns. The list
is in [the plan](plans/20261020_2104-gmail-api-mirror.md).

It starts **read-only**. It asks Google for `gmail.readonly` only, and MixOS
refuses every method that would change the mailbox. To let apps change it, allow
changes for Gmail in Admin > Connectors and connect again, and Google asks for
`gmail.modify` as well. Even then, an app can change mail only if it asks for
write access to Gmail.

It never deletes mail for good, since that needs full access to the mailbox
(`https://mail.google.com/`), which it never asks for. Trash is as far as it
goes. It doesn't watch the mailbox through Google's Pub/Sub push either.

The manifest lists Gmail's whole scope catalogue so the registry can show you
what exists, but it requests only `gmail.readonly`, plus `gmail.modify` once
changes are allowed.

## What you need before you start

A Google Cloud project you control, with the Gmail API enabled and an OAuth
client ID of type *Web application*. The registry walks you through it — the
steps, the links and this deployment's redirect URI are all rendered from the
manifest, so follow them there rather than from memory.

Set the OAuth consent screen's **User type** to *Internal*. Google's restricted
Gmail scopes otherwise pull you into app verification and an annual CASA
security assessment, and refresh tokens start expiring every seven days.

## Whose mailbox it reads

Whichever Google account approves the authorization. That is a real decision,
not a formality: it is tenant-scoped, so every user of every app that uses this
connector reads *that* mailbox.

Connect it as the shared mailbox account, not as yourself, unless you genuinely
intend your own mail to be what the workspace sees. The verify step reports
which mailbox you actually landed on — read it before you rely on it.

## Building an app with it

Name the version you build against in your app's `app.json`, and add
`"access": "write"` only if the app changes mail:

```json
"connectors": [{ "name": "gmail", "version": "1.0.0" }]
```

A message is Google's `Message`, its MIME tree intact, with `decoded` beside
it: the headers, with names lowercased, the first text and HTML bodies, and the
attachments. Lists return one page, as Google's do; pass `nextPageToken` back as
`pageToken` for the next.

Needs MixOS 0.4.0 or later.

## Worth knowing

- Requests time out at 10s with a 20s overall deadline. Reads, and changes that
  land the same however often they run, are retried up to three times. A send,
  an insert, an import and a label create are not.
- Responses are capped at 20 MB, which bounds what a large attachment can pull
  into memory.
- Every call is recorded against the declared telemetry methods, so the Usage
  Logs page shows what was read or changed, and when.
