# Connect WhatsApp Business

This integration uses Meta's WhatsApp Business Platform (Cloud API). It receives new messages with the customer's WhatsApp profile name, creates inbox conversations, sends text replies within the 24-hour service window, and applies delivery/read receipts to their exact message IDs. Media messages retain their type, caption and media ID; downloading/displaying authenticated WhatsApp media is not implemented yet. History import and phone-app message echoes are not implemented.

## Meta prerequisites

1. Add **Connect with customers through WhatsApp** to the same Meta app used by the server. Create or select a Business Portfolio, then finish WhatsApp onboarding and number verification in Meta. The phone number must be registered for Cloud API. Do not delete or migrate an existing WhatsApp account just to test this integration.
2. For an existing WhatsApp Business phone app, use Meta's eligible **Coexistence** onboarding if you need to keep the phone app. Availability and approval requirements are controlled by Meta. Personal WhatsApp cannot connect directly through this API.
3. Configure the **WhatsApp Business Account** webhook object using the existing public `/webhooks/meta` endpoint and `META_VERIFY_TOKEN`. Subscribe its **messages** field. The existing Page/Messenger webhook subscription is a separate object and should remain configured.
4. Keep `META_APP_SECRET` and `CHANNEL_KEY_V1` configured on the webhook receiver and workers. Keep the API, receiver, worker, realtime server and public tunnel running for local testing.

## Connect WhatsApp button

Configure **Facebook Login for Business → Configurations** with the **WhatsApp Embedded Signup** variation and the required WhatsApp asset permissions (`whatsapp_business_management` and `whatsapp_business_messaging`). Set its ID as `META_WHATSAPP_CONFIG_ID`, alongside `META_APP_ID` and `META_APP_SECRET`. Configure the app domains/allowed JavaScript SDK origins for the web application's origin. Restart the API after editing `.env`.

The Channels page loads the Meta SDK only when signup is configured. The user clicks **Connect WhatsApp**, authorizes in Meta, and completes business/phone verification. The server exchanges the one-time code, verifies the selected phone belongs to the authorized WABA, encrypts the token and subscribes the app to that WABA. Tokens never return to the browser. The server validates a short-lived same-site state cookie and the normal app session/permissions before accepting completion.

Meta may require business verification, provider onboarding, App Review and advanced access before other businesses can authorize. Adding a button does not bypass these requirements. Complete number registration in Meta before expecting messages; a successful WABA subscription alone does not register a number.

The **Keep using my WhatsApp Business phone app** option requests Coexistence onboarding. Leave it selected for an existing Business app number. The Connect button stays disabled until an actual WhatsApp Embedded Signup configuration is available on the server; a General Facebook Login configuration cannot replace it.

## Existing Cloud API number

Under **Advanced**, enter the WABA ID, phone number ID (not the phone number itself), and a token generated for this same Meta app with both WhatsApp permissions. For ongoing use, use a suitable long-lived business/system-user token; temporary testing tokens expire. The server verifies WABA membership before saving credentials. A failed WABA subscription saves the account as **Needs attention**; fix the Meta webhook and reconnect with valid credentials.

The account shows Connected only after Meta reports the number as `CONNECTED` and accepts the WABA subscription. Otherwise, finish number registration and webhook setup, then select **Retry setup**. Reconnecting a number in the same workspace updates its credentials without losing conversations. Disconnecting stops local ingestion and removes the local credential; it does not unsubscribe the whole WABA, which may contain other connected numbers.

Send a **new** WhatsApp message from another phone to the business number. Confirm the WhatsApp conversation and profile name in Inbox, then reply within the service window. This integration does not send template messages outside that window.

Sources: [Meta Cloud API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [Meta Embedded Signup](https://www.postman.com/meta/whatsapp-business-platform/documentation/du6gzjv/embedded-signup).
