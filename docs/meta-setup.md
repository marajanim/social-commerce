# Connect Facebook Messenger

## Fix `(#200) Requires pages_manage_metadata permission`

This is a refusal from Meta. The application cannot add permissions to an existing token.

1. Open [Graph API Explorer](https://developers.facebook.com/tools/explorer/) and select the Meta app used for Messenger and webhooks.
2. Generate a user access token requesting `pages_show_list`, `pages_manage_metadata`, and `pages_messaging`. Grant access to the intended Page. The Facebook account must have the required Page access; use an app administrator or tester when testing an app in development mode.
3. Select **Get Page Access Token** for that Page. Paste the resulting **Page** token and matching Page ID into Channels → Advanced. Do not paste the user token.
4. If a permission is unavailable, configure the app's Messenger use case and permission access in the Meta dashboard first. Do not repeatedly retry the same token.

Manual token connection works without Facebook OAuth credentials. The yellow Facebook-login warning describes a separate setup requirement.

## Enable Continue with Facebook

Set `META_APP_ID` and `META_APP_SECRET` in the local `.env` using the same Meta app. Keep secrets out of source control and chat. Keep the existing `CHANNEL_KEY_V1`; replacing it makes saved credentials unreadable.

Register `http://localhost:3000/api/channels/meta/callback` as a valid OAuth redirect URI for local development. For Facebook Login for Business, also set `META_LOGIN_CONFIG_ID` and include `pages_show_list`, `pages_messaging`, `pages_manage_metadata`, and `pages_read_engagement` in that login configuration. Restart the API after changing `.env`.

## Receive messages

Set `PUBLIC_WEBHOOK_URL` to the public HTTPS address of the webhook receiver (port 4002 locally), and set `META_VERIFY_TOKEN`. Register the resulting `/webhooks/meta` URL and matching verification token in the same Meta app. `META_APP_SECRET` is required to verify incoming webhook signatures even when connecting manually.

Enable both subscription levels in Meta's Messenger settings:

1. Under **Configure webhooks → Webhook Fields**, subscribe the app to `messages`, `messaging_postbacks`, `message_echoes`, `message_deliveries`, and `message_reads`.
2. Under **Generate access tokens**, confirm the same fields are subscribed for each connected Page. Connecting a Page through this application's OAuth flow requests these Page subscriptions automatically, but does not configure the app-level fields.

After configuring both levels, send a new message from an eligible personal Facebook profile to the Page. Earlier messages are not imported automatically. If nothing appears, check Meta's **Show Recent Errors**, the public tunnel, and the webhook receiver and worker processes.

If the Page shows **Needs attention**, fix the webhook settings and select **Retry setup**. If permissions are missing, generate a newly authorized Page token, disconnect the saved Page, and reconnect with it. A saved Page alone does not mean incoming messages work.

For local development, a Cloudflare quick tunnel can forward public HTTPS traffic to the webhook receiver on port 4002. Keep the tunnel and development servers running. Restarting a quick tunnel creates a new URL: update `PUBLIC_WEBHOOK_URL`, reload the server configuration, and verify the new callback URL in Meta. Use a stable hosted endpoint for ongoing customer traffic.

An unpublished Meta app is limited to development testing with app administrators, developers, and testers. Public customer messaging requires Meta's applicable review and publishing requirements.

Reference: [Meta Messenger Platform API](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api).
