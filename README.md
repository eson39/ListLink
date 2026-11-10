# ListLink (ListRelay)

ListRelay watches your Gmail for new listserv emails addressed to `cs3157@lists.cs.columbia.edu`, ignores subjects containing `ANN`, and posts each email's subject to a Slack channel **as your own Slack account**. An on/off switch controls automatic posting.

The Gmail search it uses is exactly:

```text
to:cs3157@lists.cs.columbia.edu -subject:ANN
```

## Requirements

- Node.js 22.13 or newer (uses the built-in `node:sqlite`; there are no npm dependencies).
- A Google Cloud OAuth client with the Gmail API enabled.
- A Slack app with user token scopes (workspace admin approval may be required).

## Quick start

```bash
cp .env.example .env   # then fill in the values below
npm start              # http://localhost:3157
```

Open the settings page, connect Gmail and Slack, choose a channel, click **Save Settings**, optionally **Send Test Message**, then flip the switch to **ON**.

## 1. Gmail (Google Cloud)

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Gmail API**.
2. Configure the OAuth consent screen (External, or Internal if your Workspace allows it). Add your address as a test user.
3. Create an OAuth client ID of type **Web application** with this authorized redirect URI:
   `http://localhost:3157/oauth/google/callback` (adjust if you change `BASE_URL`).
4. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

ListRelay requests only `gmail.readonly`, the narrowest Gmail scope that supports search queries. It reads message metadata (Subject and From headers, labels, received time), never bodies or attachments.

Notes:
- While the consent screen is in **Testing** status, Google expires refresh tokens after 7 days, so you will be asked to reconnect weekly. Publishing the app (even unverified, for personal use) avoids that.
- Columbia LionMail is Google Workspace; if the administrator blocks unverified third-party apps, connect a personal Gmail that receives the list instead.

## 2. Slack

Create an app at [api.slack.com/apps](https://api.slack.com/apps). Under **OAuth & Permissions → User Token Scopes**, add:

| Scope | Why |
|---|---|
| `chat:write` | Post messages as you. |
| `channels:read` | List public channels you belong to. |
| `groups:read` | List private channels you belong to. |

Do not add bot scopes: ListRelay never posts as a bot. If posting as you is not possible, setup shows the problem and automation stays off.

Then connect one of two ways:

- **Paste a token (simplest):** click **Install to Workspace** (your workspace may require admin approval), copy the **User OAuth Token** (`xoxp-…`), and paste it on the settings page.
- **Connect Slack button:** Slack requires HTTPS redirect URLs. Create a local certificate (for example with [mkcert](https://github.com/FiloSottile/mkcert): `mkcert localhost`), set `TLS_CERT_FILE` / `TLS_KEY_FILE`, add `https://localhost:3157/oauth/slack/callback` as the app's redirect URL, and set `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET`. If you enable HTTPS, update the Google redirect URI to `https://` as well.

## How it behaves

- **Off by default.** The switch can only be turned on once Gmail, Slack, and a channel are set up; turning it on re-verifies both connections and your channel membership.
- **Only new email.** Turning the switch on records the activation time. Emails received before it (including anything that arrived while paused) are never posted.
- **Incoming only.** Messages labeled `SENT`/`DRAFT` or sent from your own address are skipped. Each reply in a thread is a separate email.
- **Once per email.** Every Gmail message ID is recorded before posting, so rechecks never duplicate a post.
- **Plain text.** Only the subject is posted, with Slack formatting, links, and mentions neutralized. A missing subject is posted as `(No subject)`.
- **Off means off.** Turning the switch off stops new posts and cancels pending retries; a request already in flight may finish. The switch state survives restarts.
- **Errors.** Expired Gmail or Slack authorization pauses processing and shows a reconnect action. Channel problems (not a member, archived, restricted) pause delivery until you save settings or a test succeeds. Rate limits and outages are retried with increasing delays (honoring `Retry-After`, up to 8 times). If Slack times out and the post may have gone through, it is marked **Needs review** instead of being reposted; you can retry or dismiss it.
- **Activity** lists posts, skipped emails, errors, and connection events. History older than 30 days is pruned.

Gmail is checked about once per minute (`POLL_INTERVAL_SECONDS`). If processing is paused by an error while the switch is on, emails that arrive during the outage are posted once it is fixed.

## Security

- The server listens on `127.0.0.1` only, rejects unexpected `Host` headers, and requires a CSRF token (regenerated each time the server starts) on every change. Binding to another address requires `APP_PASSWORD` (HTTP Basic auth).
- OAuth tokens are encrypted with AES-256-GCM in `data/listrelay.db`. The key comes from `LISTRELAY_SECRET_KEY` or `data/secret.key` (created with mode 600). Tokens never appear in logs or activity.
- Only the subject, received time, and Gmail message ID are stored for each email.
- **Disconnect** revokes the token with Google/Slack, deletes it, and turns automation off.

## Development

```bash
npm test
```

Tests use fake Gmail and Slack clients and cover each acceptance criterion in the design document.

| Path | Purpose |
|---|---|
| `src/filter.js` | The fixed filter, ANN matching, subject cleanup, Slack escaping |
| `src/relay.js` | Gmail checks, dedupe, on/off switch, delivery and retries |
| `src/gmail.js`, `src/slack.js` | API clients and error classification |
| `src/store.js`, `src/secrets.js` | SQLite storage and credential encryption |
| `src/web.js`, `src/server.js` | Settings screen, OAuth flows, server |
