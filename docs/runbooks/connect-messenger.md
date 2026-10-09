# Connect your Facebook Page to the inbox

**Continue with Facebook** connects a Page in a few clicks. You set up the Meta app once; after that
every Page is a button press. You need a Meta developer app and a public URL that reaches the webhook
receiver.

## 1. Server settings (`.env`)

| Variable | Value |
| --- | --- |
| `CHANNEL_KEY_V1` | 32 random bytes, base64. `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Back it up outside the database; without it stored tokens cannot be read. |
| `META_APP_ID`, `META_APP_SECRET` | Meta app dashboard, Settings, Basic. The secret verifies every webhook signature and completes the Facebook login. |
| `META_VERIFY_TOKEN` | Any string you choose. You paste the same string into Meta. |
| `PUBLIC_WEBHOOK_URL` | The public address of the webhook receiver (port 4002). In development use a tunnel, for example `cloudflared tunnel --url http://localhost:4002` or `ngrok http 4002`. |
| `META_LOGIN_CONFIG_ID` | Only for Facebook Login for Business apps (see below). |
| `WEB_ORIGIN` | The address you open the app at (`http://localhost:3000` in development). Facebook sends the browser back here. |

Restart the API, webhook receiver and worker after changing them. The Channels page shows
"Continue with Facebook" once `META_APP_ID`, `META_APP_SECRET` and `CHANNEL_KEY_V1` are all set.

## 2. Meta app (once)

1. developers.facebook.com, create an app (type Business). Add the **Messenger** product and the **Facebook Login** product.
2. **Facebook Login, Settings, Valid OAuth Redirect URIs:** add `WEB_ORIGIN/api/channels/meta/callback` (the Channels page shows the exact address to copy).
3. **Messenger, Webhooks:** callback URL `PUBLIC_WEBHOOK_URL/webhooks/meta` and your verify token. Both are shown on the Channels page. This is per app, not per Page.
4. While the app is in Development mode, people with a role on the app (admin, developer, tester) can log in, connect their Pages and be messaged, with no App Review. Add yourself and your test accounts under App roles. Letting other businesses connect needs App Review and a Live app; that is Phase 2.

The login asks for `pages_show_list`, `pages_messaging`, `pages_manage_metadata` and `pages_read_engagement`.

**Apps that use Facebook Login for Business** (the sidebar shows that name): create a Configuration (Facebook Login for Business, Configurations, Create) that includes those four permissions, copy its Configuration ID into `META_LOGIN_CONFIG_ID` in `.env`, and register the redirect address under Facebook Login for Business, Settings.

## 3. Connect a Page

1. Channels, **Continue with Facebook**, approve, and choose the Page if you manage several.
2. The app stores the Page token encrypted and subscribes the Page to `messages`, `messaging_postbacks`, `message_echoes`, `message_deliveries` and `message_reads` itself.
3. Disconnecting a Page unsubscribes it and deletes the token.

The old manual route (paste a Page ID and token) is still on the page under *Advanced*.

## 4. Check it

- Send a message to your Page from a test account. It should appear in the inbox within a second or two.
- Reply from the inbox. The tick goes from clock (sending) to one tick (sent), two ticks (delivered), blue (seen).
- Reply from Meta Business Suite. It appears as "Sent from another app".

## When something is off

| Symptom | Check |
| --- | --- |
| No Facebook button | `META_APP_ID`, `META_APP_SECRET` and `CHANNEL_KEY_V1` must all be set (the page lists what is missing). |
| Facebook says the redirect URI is not allowed | The address under Valid OAuth Redirect URIs must match the one on the Channels page exactly, including `http` or `https`. |
| "The login could not be verified" | The browser lost the short-lived state cookie (a different browser, or more than 10 minutes). Start again. |
| "Facebook returned no Pages" | The Facebook account manages no Page, or you unticked the Page in the permission dialog. |
| "Needs attention" right after connecting | Facebook refused the webhook subscription: check the Meta app has the Messenger product and your user has a role on the app. Disconnect and connect again. |
| Meta rejects the callback URL | The tunnel is running, the URL ends in `/webhooks/meta`, `META_VERIFY_TOKEN` matches. |
| Nothing arrives | `webhook_events` table: rows with `status = 'quarantined'` mean the Page ID is not connected (or disconnected); `failed` rows have the error. |
| Rows arrive but no conversation | The worker is not running, or Redis is down. The sweeper retries stored events every 15 seconds. |
| Replies stay on the clock icon | Worker not running, or `CHANNEL_KEY_V1` missing on the worker. The sweeper retries pending replies after 30 seconds. |
| A reply is refused: window closed | Messenger allows replies for 24 hours after the customer's last message, and up to 7 days with the Human Agent tag, which the app adds on its own. After 7 days only the customer can restart the chat. |
