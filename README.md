# Gmail

Read-only access to a Gmail mailbox, so apps in your workspace can search,
read and summarise mail without anyone pasting messages around.

## What it can reach

Messages, conversation threads, labels and attachments. It is **read-only**: the
scope it requests by default (`gmail.readonly`) cannot send, reply, label,
archive or delete anything, and there is no configuration that makes it able to.

The manifest declares Gmail's full scope list so the registry can show you what
exists, but only `gmail.readonly` is marked `requested`.

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

## Worth knowing

- Requests time out at 10s with a 20s overall deadline, and are retried up to
  three times.
- Responses are capped at 20 MB, which bounds what a large attachment can pull
  into memory.
- Every call is recorded against the declared telemetry methods, so the Usage
  Logs page shows what was read and when.
