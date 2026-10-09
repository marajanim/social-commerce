# Connect your Facebook Page to the inbox

Phase 1 connects your own Page with a Page access token (no OAuth screen yet). You need a Meta
developer app, a public URL that reaches the webhook receiver, and about 15 minutes.

## 1. Server settings (`.env`)

| Variable | Value |
| --- | --- |
| `CHANNEL_KEY_V1` | 32 random bytes, base64. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Back it up outside the database; without it stored tokens cannot be read. |
| `META_APP_ID`, `META_APP_SECRET` | Meta app dashboard, Settings, Basic. The secret verifies the signature of every webhook. |
| `META_VERIFY_TOKEN` | Any string you choose. You paste the same string into Meta. |
| `PUBLIC_WEBHOOK_URL` | The public address of the webhook receiver (port 4002). In development use a tunnel, for example `cloudflared tunnel --url http://localhost:4002` or `ngrok http 4002`. |

Restart the API, webhook receiver and worker after changing them.

## 2. Meta app

1. developers.facebook.com, create an app (type Business), add the **Messenger** product.
2. Messenger settings, Webhooks: callback URL `PUBLIC_WEBHOOK_URL/webhooks/meta` and your verify token. The Channels page in the app shows both values ready to copy.
3. Subscribe the Page to: `messages`, `messaging_postbacks`, `message_echoes`, `message_deliveries`, `message_reads`.
4. While the app is in Development mode, only people with a role on the app (admins, developers, testers) can message you and be seen. Add a test account, or switch the app to Live (needs a privacy policy URL and a data-deletion URL).

## 3. Connect in the app

1. Messenger settings, Access tokens, generate a token for your Page.
2. Channels page, Facebook Messenger: Page ID, optional display name, token, Connect.
3. The server asks Facebook who the token belongs to, refuses it if the Page differs, and stores the token encrypted.

## 4. Check it

- Send a message to your Page from a test account. It should appear in the inbox within a second or two.
- Reply from the inbox. The tick goes from clock (sending) to one tick (sent), two ticks (delivered), blue (seen).
- Reply from Meta Business Suite. It appears as "Sent from another app".

## When something is off

| Symptom | Check |
| --- | --- |
| Meta rejects the callback URL | The tunnel is running, the URL ends in `/webhooks/meta`, `META_VERIFY_TOKEN` matches. |
| Nothing arrives | `webhook_events` table: rows with `status = 'quarantined'` mean the Page ID is not connected (or disconnected); `failed` rows have the error. |
| Rows arrive but no conversation | The worker is not running, or Redis is down. The sweeper retries stored events every 15 seconds. |
| Replies stay on the clock icon | Worker not running, or `CHANNEL_KEY_V1` missing on the worker. The sweeper retries pending replies after 30 seconds. |
| Channel shows "Needs attention" | Facebook rejected the token (expired or revoked). Generate a new one and reconnect the Page. |
| A reply is refused: window closed | Messenger allows replies for 24 hours after the customer's last message, and up to 7 days with the Human Agent tag, which the app adds on its own. After 7 days only the customer can restart the chat. |
