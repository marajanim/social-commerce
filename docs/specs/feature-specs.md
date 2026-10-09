# Feature Specs: Core Modules — AI Social Commerce SaaS

Oct 9, 2026 · @PM Dev

## Overview and shared conventions

These specs turn eight blueprint modules into buildable requirements for the MVP and v1, for Bangladesh-first social-commerce merchants. They assume the blueprint stack: Next.js frontend, NestJS modular monolith, PostgreSQL, Redis + BullMQ workers, Socket.IO realtime, S3-compatible storage.

**Scope by phase.** **Phase 1 (own shop):** one workspace — yours — with Facebook Messenger DMs and Page comments, the inbox on your phone, the AI in Draft and Supervised modes, and catalog and orders. **Phase 2 (SaaS):** signup for other merchants, website widget, routing between agents, contacts and CRM, billing, analytics. **v1:** Instagram, WhatsApp, broadcasts, courier APIs. Everything is built multi-tenant from day one, so Phase 2 adds features rather than a rewrite. Sections below describe the full product; the build plan says which parts are Phase 1.

### Conventions that apply to every module

- **Tenancy:** every table carries `tenant_id`; every query, cache key, queue job, file path and vector search is filtered by it. Cross-tenant access is a P0 bug.
- **Money:** integer minor units (poisha for BDT), with a `currency` column. Never floats.
- **Time:** stored as UTC instants; displayed in the tenant timezone (default Asia/Dhaka). Provider timestamps are kept as received.
- **IDs:** UUIDv7 internally; provider IDs stored in their own columns with a unique index per tenant + provider.
- **APIs:** REST under `/api/v1`, JSON, cursor pagination (`?cursor=&limit=`), `Idempotency-Key` header required on every create that has side effects.
- **Events:** written to an outbox table in the same transaction as the state change, then published to BullMQ. Event names use `module.entity.verb` (for example `inbox.message.received`).
- **Realtime:** Socket.IO rooms per tenant, per conversation and per user; clients resync by cursor after reconnect.
- **Audit:** every permission-gated write records actor, action, target, before/after and correlation ID.
- **Permissions:** enforced server-side on every endpoint and socket event; the UI only hides what the server already refuses.

### Shared roles

Permission tables in each module use these roles. Custom roles (v1) are built from the same permission keys.

| Role | Who | Summary |
| --- | --- | --- |
| Owner | Business owner, one per workspace | Everything, including billing, deletion and ownership transfer |
| Admin | Trusted manager | Everything except ownership transfer and workspace deletion |
| Supervisor | Team lead | Sees all conversations, reassigns, monitors agents, views analytics |
| Agent | Sales or support staff | Works conversations assigned to them or their team |
| Order manager | Fulfilment staff | Orders, couriers and the customer details orders need |
| Analyst | Read-only staff | Analytics and exports allowed by Admin, no messaging |
| Platform admin | Your company's staff | Separate console; tenant data only through logged, time-limited support access |

## Module 1: Unified Inbox

One realtime workspace where agents see every conversation from every connected channel, reply within each channel's rules, and take over from or hand back to the AI. Success = an agent can answer, share a product and create a draft order without leaving the conversation view.

### User flows

**Flow 1.1 — Handle a new conversation**

1. A customer message arrives; the conversation appears at the top of the list with an unread badge and channel icon (realtime, under 2 seconds after the webhook is accepted).
2. The agent opens it; the thread loads the latest 50 messages, the right panel loads the customer profile, recent orders and AI summary.
3. If the AI is in supervised mode, a suggested reply appears in the composer, marked as AI draft.
4. The agent edits or accepts the draft, optionally attaches a product card or image, and sends.
5. The message shows statuses as the channel reports them: sending → sent → delivered → read, or failed with a reason and a retry action.
6. The agent sets a label, adds an internal note if needed, and marks the conversation resolved or snoozed.

**Flow 1.2 — Take over from the AI**

1. Agent clicks Take over on an AI-handled conversation.
2. Server sets owner = that agent and cancels any queued or in-flight AI reply jobs for the conversation before confirming.
3. A system event (“Rafi took over from AI”) appears in the thread; other viewers see it live.
4. Return to AI: agent clicks Hand back; the AI resumes only on the next inbound customer message, never by replying to old ones.

**Flow 1.3 — Reply outside the messaging window**

1. The composer shows the window state for the channel (for example “Window closes in 3h 12m” or “Window closed”).
2. If closed, free text is disabled. The composer offers only what the channel allows: an approved WhatsApp template, or a Messenger/Instagram human-agent tagged reply if still inside that tag's limit.
3. The server re-checks eligibility at send time; the UI check is only a hint.

**Flow 1.4 — Search and filter**

1. Agent filters by status, assignee, team, channel, label, AI-handled, unread or SLA breached; filters combine.
2. Search covers customer name, phone, message text and order number within the tenant.
3. Saved views (v1) store filter sets per user.

### UI screens

| Screen | Contents |
| --- | --- |
| Inbox (three-pane, desktop) | Left: views, filters, conversation list. Centre: thread + composer. Right: customer, orders, AI summary, labels |
| Inbox (mobile/PWA) | List → thread → profile as separate screens; quick replies; push notifications |
| Composer | Text, emoji, attachments, saved replies (`/` shortcut), product picker, AI draft, rewrite/translate, internal-note toggle, window indicator, template picker |
| Conversation header | Customer name, channel, owner (AI or agent), status, assign, snooze, resolve, take over / hand back |
| Saved replies manager | Create, edit, share with team; variables like {{customer.first\_name}} |
| Labels manager | Create, colour, archive labels |

Every screen needs empty, loading, error, offline/reconnecting, permission-denied and channel-disconnected states.

### Business rules

- **One thread per customer per channel account.** A new message on a resolved conversation reopens it rather than creating a new one, unless the conversation was resolved more than 30 days ago (configurable).
- **Statuses:** `open`, `pending` (waiting on customer), `snoozed` (until a time), `resolved`. `unread` is per user, not a status.
- **Ownership:** exactly one owner at a time: the AI or one human. Only the owner, a Supervisor, Admin or Owner can send in an owned conversation; others see a “Rafi is replying” lock and can leave notes.
- **Collision guard:** typing indicators between agents; the server rejects a second reply sent within 5 seconds of another agent's reply in the same conversation unless confirmed.
- **Internal notes** are stored `in a separate conversation_notes table`, styled differently, and can never be sent to a channel by any code path.
- **Ordering:** messages are ordered by provider timestamp, then by received time; late-arriving older messages are inserted in place, not appended.
- **Deduplication:** unique index on (tenant, channel\_account, provider\_message\_id).
- **Attachments:** images up to 10 MB in-app; files above a channel's limit are rejected before upload with that channel's limit shown.
- **SLA:** first-response and next-response timers per tenant business hours; breached conversations are flagged and notify the Supervisor.

* **Replies sent outside the app.** When someone replies from Meta Business Suite or the Facebook app, Meta sends an echo event. An echo from any app other than ours is stored as a human outbound message, the conversation becomes human-owned, queued AI replies are cancelled, and the AI pauses for that conversation (default 2 hours, configurable). Echoes of our own sends are matched to the existing message and ignored.
* **Cross-tenant lookups return 404**, never 403, so the response does not reveal that the ID exists.

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| Customer sends 5 messages in 10 seconds | All shown immediately; AI waits for a debounce window (default 8 s after the last message) and replies once |
| Agent sends while socket is disconnected | Message queued locally with a pending state; sent on reconnect with its idempotency key; no duplicate |
| Channel send fails (token expired, window closed, rate limited) | Message marked failed with a readable reason; retry action; token errors also raise a channel-health alert |
| Customer deletes or edits a message (where the channel reports it) | Thread shows “message deleted” or the edit marker; original kept for audit per retention policy |
| Two agents open the same conversation | Both see live updates; only the owner's composer is active |
| Unsupported message type (sticker, story reply, location) | Shown as a typed placeholder with a link to view on the platform where possible |
| Channel disconnected | Conversations stay readable; composer disabled with a reconnect prompt for Admins |
| Agent deactivated while owning conversations | Conversations return to the team queue and are reassigned by routing rules |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| View all conversations | Yes | Yes | Yes | Own + team (configurable) | Linked to orders | No |
| Reply | Yes | Yes | Yes | When owner | No | No |
| Internal notes | Yes | Yes | Yes | Yes | Yes | No |
| Assign / reassign | Yes | Yes | Yes | Self-assign only | No | No |
| Take over from AI | Yes | Yes | Yes | Yes | No | No |
| Manage labels and saved replies | Yes | Yes | Yes | Personal only | No | No |
| Export conversations | Yes | Yes | No | No | No | No |

### Data entities

| Entity | Key fields |
| --- | --- |
| conversation | id, tenant\_id, customer\_id, channel\_account\_id, status, owner\_type (ai/user), owner\_user\_id, team\_id, last\_message\_at, last\_inbound\_at, window\_expires\_at, snoozed\_until, sla\_due\_at, ai\_mode |
| message | id, tenant\_id, conversation\_id, direction (in/out), sender\_type (customer/user/ai/system), sender\_id, body, payload\_json, provider\_message\_id, status, failure\_code, sent\_at, delivered\_at, read\_at, idempotency\_key |
| attachment | id, tenant\_id, message\_id, type, mime, size\_bytes, storage\_key, provider\_media\_id |
| conversation\_event | id, tenant\_id, conversation\_id, type (assigned, taken\_over, resolved, reopened…), actor, data\_json, created\_at |
| label, conversation\_label | tenant-scoped labels and the join table |
| saved\_reply | id, tenant\_id, owner\_user\_id (null = shared), shortcut, body, attachments |
| read\_marker | tenant\_id, user\_id, conversation\_id, last\_read\_message\_id |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| inbox.message.received | Inbound message stored | Owner, or team queue if unassigned (in-app, push) |
| inbox.message.status\_changed | Sent/delivered/read/failed | Sender (in-app); failures also in-app alert |
| inbox.conversation.assigned | Owner set or changed | New assignee (in-app, push) |
| inbox.conversation.taken\_over | Human takes over from AI | Thread viewers (realtime) |
| inbox.conversation.handoff\_requested | AI or customer asks for a human | Team queue + Supervisor (in-app, push) |
| inbox.sla.breached | SLA timer expires | Assignee + Supervisor |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /conversations | List with filters and cursor |
| GET | /conversations/{id} | Conversation detail |
| PATCH | /conversations/{id} | Status, snooze, labels |
| POST | /conversations/{id}/assign | Assign to user or team |
| POST | /conversations/{id}/takeover | Human takes ownership; cancels AI jobs |
| POST | /conversations/{id}/handback | Return to AI |
| GET | /conversations/{id}/messages | Paged history (before/after cursor) |
| POST | /conversations/{id}/messages | Send reply, note, product card or template (Idempotency-Key required) |
| POST | /messages/{id}/retry | Retry a failed outbound message |
| GET | /conversations/{id}/send-eligibility | Window state and allowed message types |
| GET/POST/PATCH/DELETE | /saved-replies, /labels | Manage saved replies and labels |
| GET | /search?q= | Tenant-scoped search |
| WS | inbox namespace | message.new, message.status, conversation.updated, typing, presence |

## Module 2: Channel Integrations

One adapter per channel turns provider webhooks into normalized messages and sends replies back within each platform's rules. MVP ships Facebook Messenger and the website widget; Instagram and WhatsApp Cloud API follow in v1. Every outbound send passes one server-side eligibility check, so no feature can break a platform rule by accident.

### Platform constraints the adapters must enforce

Facts below were checked against Meta's developer docs on 9 Oct 2026; Meta changes these often, so the Open questions section lists what to re-verify before launch.

| Constraint | Facebook Messenger | Instagram DM | WhatsApp Cloud API |
| --- | --- | --- | --- |
| Standard reply window | 24 h from the customer's last message | 24 h from the customer's last message | 24 h customer service window (CSW) from the customer's last message |
| Outside the window | HUMAN\_AGENT tag: human-sent replies up to 7 days after the customer's last message (needs Meta approval); other tags limited | HUMAN\_AGENT tag only, 7 days, human-sent | Approved templates only |
| Automated (AI) replies | Only inside 24 h; AI can never use HUMAN\_AGENT | Only inside 24 h | Free-form only inside CSW; templates outside |
| Comment to DM | One private reply per comment, within 7 days | One private reply per comment, within 7 days; conversation continues only if the user replies | Not applicable |
| Send rate | 300 calls/s per Page for text/links; 10 calls/s for audio/video | 300 calls/s (Messenger API for Instagram) text; 10 calls/s audio/video; 750 private replies/hour per account | 80 messages/s per number by default (up to 1,000); error 130429 when exceeded |
| Other limits | Page above 40 messages/s can be blocked from sending until volume drops | Same Business Use Case limits as Pages | Business-initiated reach capped per business portfolio: 250, then 2,000, 10,000, 100,000, unlimited unique users per 24 h |
| Delivery statuses | Delivery and read webhooks (watermark-based) | Read events; no per-message delivered | sent, delivered, read, failed per message |
| Cost to merchant | Free | Free | Per delivered template (marketing, utility, authentication); non-template and in-window utility free per Meta's pricing page; 72 h free window after Click-to-WhatsApp ads |

Sources: [Messenger rate limits](https://developers.facebook.com/documentation/business-messaging/messenger-platform/overview/rate-limiting), [Send API and tags](https://developers.facebook.com/docs/messenger-platform/reference/send-api), [Messenger policy](https://developers.facebook.com/documentation/business-messaging/messenger-platform/policy), [Instagram private replies](https://developers.facebook.com/documentation/business-messaging/instagram-messaging/features/private-replies), [WhatsApp pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing), [WhatsApp messaging limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/messaging-limits), [WhatsApp throughput](https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput).

**WhatsApp AI policy.** Since 15 Jan 2026 WhatsApp's terms restrict general-purpose AI assistants on the Business Platform ([AI Providers policy](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers)). The AI must stay a business-specific sales and support assistant: it answers about the merchant's products, orders and policies and declines unrelated general questions.

### User flows

**Flow 2.1 — Connect a Facebook Page (and its linked Instagram account)**

1. Admin clicks Connect Facebook → Meta login dialog requests the required permissions.
2. Admin selects one or more Pages (and linked Instagram professional accounts) to connect.
3. Server exchanges the code for a long-lived token, stores it encrypted, checks granted scopes against required scopes.
4. Server subscribes the app to each Page's webhook fields (messages, deliveries, reads, postbacks, feed comments).
5. Server sends a test call; the channel shows Connected, or a specific error (missing permission, Page restricted, already connected to another workspace).
6. Optional: import the last 30 days of conversations for context (rate-limited background job).

**Flow 2.2 — Connect WhatsApp (v1)**

1. Admin starts Embedded Signup; creates or selects a business portfolio, WhatsApp Business account and phone number; verifies the number by code.
2. Server stores the WABA ID, phone number ID and token; subscribes to webhooks; reads messaging limit and quality rating.
3. Admin sets display name and business profile; workspace shows tier (for example 250/day) and the steps to raise it (business verification).
4. Starter templates (order confirmation, delivery update, payment reminder) are offered for submission.

**Flow 2.3 — Create and submit a WhatsApp template**

1. Admin writes a template: name, language (Bangla and English as separate templates), category, header, body with variables, footer, buttons.
2. Editor previews with sample values and warns about common rejection causes (promotional words in a utility template, variables at start or end, missing samples).
3. Submit → status Pending. Status webhook updates it to Approved, Rejected (with reason) or later Paused/Disabled for low quality.
4. If Meta changes the category, the template shows the new category and its cost before next use.

**Flow 2.4 — Install the website widget**

1. Admin customizes colours, greeting, avatar, pre-chat fields (name, phone optional) and allowed domains.
2. Copies a script snippet; widget connects only from allowed domains.
3. Visitor identity persists by a signed cookie; optional phone capture links the visitor to an existing contact after OTP.

**Flow 2.5 — Reconnect after token expiry or permission loss**

1. Health check or a send error detects invalid token or revoked permission.
2. Channel status becomes Needs attention; Admins get in-app, email and push alerts; inbox composer for that channel is disabled.
3. Admin clicks Reconnect and repeats the login; queued outbound messages older than their window are marked failed rather than sent late.

**Flow 2.6 — Comments to DM (Phase 1)**

1. A customer comments on a Page post (“price?”, “XL ase?”). The feed webhook delivers the comment; it appears in the inbox as a comment item linked to the post and, when mapped, to its product.
2. The agent or AI sends **one private reply** to the comment within 7 days of it being posted (Meta's limit). The reply opens a Messenger thread.
3. If the customer answers, the normal 24-hour window starts and the conversation continues as a DM with the product already known.
4. Optional: a short public reply on the comment (“Inbox kora hoyeche”), configurable per Page.
5. A comment that already has a private reply, or is older than 7 days, shows why a private reply is no longer possible.

### Inbound and outbound pipeline

1. **Verify:** GET handshake checks `hub.mode=subscribe` and the verify token, then echoes `hub.challenge`. Every POST is checked against `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with the app secret) using a constant-time compare; failures return 403 and are logged.
2. **Persist and acknowledge:** store the raw payload in `webhook_events` with a unique key, return 200 immediately (target under 1 s); never call the AI or other APIs inside the request.
3. **Queue:** a worker picks up the event; duplicates by provider event or message ID are dropped.
4. **Resolve:** map page/account/phone number ID → `channel_account` → tenant; unknown IDs go to a quarantine table, never to a default tenant.
5. **Normalize:** convert to the internal message shape; download media to tenant storage (provider media URLs expire).
6. **Upsert:** find or create contact identity and conversation; update `last_inbound_at` and window expiry; emit `inbox.message.received`.
7. **Outbound:** every send goes through `SendEligibilityService` (window, tag, template, opt-out, rate budget), then a per-channel-account send queue with rate limiting, retries with backoff on 5xx and rate-limit errors, and no retry on policy errors.
8. **Status:** delivery, read and failure webhooks update the message; status never moves backwards (read stays read if a late delivered event arrives).

### Business rules

- A channel account (Page, Instagram account, phone number) can belong to only one workspace at a time.
- Tokens are encrypted with a key-management service; plaintext tokens never appear in logs, errors or the frontend.
- Window expiry is computed from the customer's last inbound message timestamp as reported by the provider, not our receive time.
- The AI may only send free-form messages inside the standard window. HUMAN\_AGENT-tagged messages require a human user as the sender and are logged with that user's ID.
- WhatsApp templates are the only outbound path outside the CSW; the template's current category is shown with its cost before sending.
- Outbound sends respect a per-channel-account token bucket set safely below the published limits (for example 50% of the provider limit), shared across all workers via Redis.
- Error responses are classified: retryable (timeouts, 5xx, rate limit), user-fixable (token, permission, window, template), permanent (blocked by user, invalid recipient).
- Webhook subscriptions are checked by a health job every 15 minutes; a channel with no events for an unusual period is flagged.

* **OAuth exception:** the OAuth callback may call Meta synchronously to exchange the code for a token. Webhook subscription, health checks and history import run as jobs.
* **Post context:** Messenger referral data (ads, post buttons) and comment post IDs are stored on the conversation so the AI knows which product the customer means (see `product_post_links` in the commerce schema).

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| Webhook delivered twice or out of order | Dedupe by provider ID; insert by provider timestamp |
| Our API is down for 30 minutes | Meta retries delivery; on recovery, reconciliation job fetches recent conversations to fill gaps |
| Page removed from Meta Business or admin loses role | Channel set to Needs attention; inbound stops; history stays readable |
| Customer blocks the Page or WhatsApp number | Sends fail permanently; contact marked unreachable on that channel |
| WhatsApp quality rating drops or template paused | Alert Admin; block broadcasts using that template; show quality status on channel page |
| Rate limit error (Meta 613/80002, WhatsApp 130429) | Back off, pause that channel account's queue, resume gradually; alert if sustained |
| Media too large or unsupported by target channel | Rejected before send with that channel's limit |
| Message arrives for a channel account in a suspended workspace | Stored but not processed by AI; visible after reactivation |
| Same customer on Messenger and WhatsApp | Separate identities; linked only by verified phone (see Contacts) |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| Connect, reconnect or remove channels | Yes | Yes | No | No | No | No |
| View channel health | Yes | Yes | Yes | Yes | No | No |
| Create or edit WhatsApp templates | Yes | Yes | Yes | No | No | No |
| Send templates outside the window | Yes | Yes | Yes | Yes (approved list) | Utility only | No |
| Configure website widget | Yes | Yes | No | No | No | No |

### Data entities

| Entity | Key fields |
| --- | --- |
| channel\_account | id, tenant\_id, provider (messenger, instagram, whatsapp, webchat), external\_id (page, IG or phone number ID), display\_name, status, scopes, credential\_ref, quality\_rating, messaging\_limit, connected\_by, connected\_at, last\_event\_at |
| channel\_credential | id, tenant\_id, channel\_account\_id, encrypted\_token, token\_type, expires\_at, rotated\_at |
| webhook\_event | id, provider, event\_key (unique), tenant\_id (nullable until resolved), payload, signature\_valid, received\_at, processed\_at, status, error |
| contact\_identity | id, tenant\_id, contact\_id, channel\_account\_id, external\_user\_id (PSID, IGSID, wa\_id), profile\_name, last\_inbound\_at |
| wa\_template | id, tenant\_id, channel\_account\_id, name, language, category, components\_json, status, rejection\_reason, quality, provider\_template\_id |
| outbound\_job | id, tenant\_id, message\_id, channel\_account\_id, attempts, next\_attempt\_at, last\_error\_class |
| widget\_config | id, tenant\_id, allowed\_domains, theme\_json, prechat\_fields, greeting |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| channel.connected | Channel connection succeeds | Admins (in-app) |
| channel.needs\_attention | Token invalid, permission revoked, webhook silent | Owner and Admins (in-app, email, push) |
| channel.rate\_limited | Sustained rate limiting | Admins (in-app) |
| channel.template.status\_changed | Template approved, rejected, paused, recategorized | Template creator and Admins |
| channel.whatsapp.limit\_changed | Messaging limit or quality rating changes | Admins |
| channel.webhook.quarantined | Event for unknown account | Platform admin console |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /webhooks/meta | Verification handshake |
| POST | /webhooks/meta, /webhooks/whatsapp | Receive signed events |
| GET | /channels | List channel accounts and health |
| POST | /channels/facebook/connect | Start OAuth; callback stores tokens |
| POST | /channels/whatsapp/embedded-signup | Complete Embedded Signup |
| POST | /channels/{id}/reconnect | Re-authorize |
| DELETE | /channels/{id} | Disconnect and unsubscribe webhooks |
| GET | /channels/{id}/health | Token, scopes, webhook, limits, quality |
| GET/POST | /channels/{id}/templates | List or submit WhatsApp templates |
| POST | /channels/{id}/templates/sync | Pull latest statuses from Meta |
| GET/PUT | /widget/config | Website widget settings |
| WS | /widget/socket | Visitor messaging connection |

## Module 3: Routing & Assignment

Routing decides, for every conversation that needs a human, which team and which agent own it, within one second of the trigger. MVP ships manual assignment plus round-robin per team; v1 adds rules, skills, capacity and business-hours fallback.

### User flows

**Flow 3.1 — Configure routing (Admin)**

1. Admin creates teams (for example Sales, Orders, Support) and adds members.
2. For each team, chooses a method: manual queue, round-robin, or least-busy (v1).
3. Sets agent capacity (max open conversations, default 15) and business hours per team.
4. Builds ordered rules (v1): if channel = WhatsApp and intent = complaint → Support team; if contact tag = VIP → Senior agents; else → Sales.
5. Sets fallback: outside hours → AI keeps handling with an away message, or queue for the next shift.
6. Tests a rule set against the last 100 conversations (“would route to” preview) before publishing.

**Flow 3.2 — Automatic routing of a handoff**

1. Trigger: the AI requests a human, a customer asks for one, a rule matches a new conversation, or the AI confidence check fails.
2. Rules engine evaluates rules top to bottom; first match picks the team.
3. Within the team, the method picks an available agent under capacity; ties go to the agent idle longest.
4. Assignment is written in one transaction with a conversation\_event; agent gets in-app and push notification.
5. If no agent is available, the conversation waits in the team queue with its wait time shown; Supervisor alerted after the queue SLA (default 5 minutes).

**Flow 3.3 — Agent availability**

1. Agent sets status: Online, Away, Offline. Auto-Away after 10 minutes without activity in the app.
2. Going Offline offers: keep my conversations, or return them to the team queue.
3. Supervisor sees a live board of agents, status, open load and oldest waiting conversation.

**Flow 3.4 — Manual transfer**

1. Agent or Supervisor clicks Transfer, picks a team or person, adds a note.
2. Receiver is notified; the note appears as an internal note in the thread.

### UI screens

| Screen | Contents |
| --- | --- |
| Teams | Team list, members, method, capacity, hours |
| Routing rules (v1) | Ordered rule list, conditions, target, enable toggle, test preview |
| Agent status menu | Online/Away/Offline, current load |
| Supervisor live board | Agents, status, load, queue sizes, oldest waiting, reassign actions |
| Business hours and holidays | Weekly schedule per team, holiday dates (Eid, Pohela Boishakh, etc.) |

### Business rules

- A conversation has at most one team and one owner. AI ownership and human ownership are mutually exclusive.
- Routing never assigns to an agent who is Offline, deactivated, over capacity or lacks permission for that channel.
- Sticky ownership: a returning customer within 7 days goes back to their last agent if that agent is available (configurable).
- Round-robin pointer is stored per team in Redis with a database fallback; it survives restarts.
- Assignment uses optimistic locking on the conversation row; two simultaneous routings cannot assign twice.
- Resolved conversations release capacity immediately; snoozed ones count toward capacity (configurable).
- Rule conditions may use: channel, channel account, contact tags, segment, language, AI-detected intent, order status, time of day.

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| All agents offline | AI continues (if allowed) with an away message; conversation queued for next shift; no auto-assign to offline agents |
| Agent goes offline mid-conversation | Their conversations stay assigned until a timeout (default 30 min), then return to the queue |
| Rule points to a deleted team | Rule is disabled automatically; fallback team used; Admin alerted |
| Burst of 200 conversations from a viral post | Queue fills; capacity limits respected; Supervisor sees queue depth; AI handles first responses where allowed |
| Two Supervisors reassign at once | Second request gets a conflict error with the current owner shown |
| Routing worker down | Conversations remain unassigned and visible in the queue; health alert raised |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| Manage teams and rules | Yes | Yes | Own teams (members only) | No | No | No |
| Reassign any conversation | Yes | Yes | Yes | No | No | No |
| Transfer own conversation | Yes | Yes | Yes | Yes | No | No |
| Set own status | Yes | Yes | Yes | Yes | Yes | No |
| Set others' status | Yes | Yes | Yes | No | No | No |
| View live board | Yes | Yes | Yes | No | No | Read only |

### Data entities

| Entity | Key fields |
| --- | --- |
| team | id, tenant\_id, name, method, default\_capacity, business\_hours\_id, queue\_sla\_seconds |
| team\_member | tenant\_id, team\_id, user\_id, capacity\_override, skills\[\] |
| routing\_rule | id, tenant\_id, position, name, conditions\_json, target\_team\_id, target\_user\_id, enabled, version |
| agent\_presence | tenant\_id, user\_id, status, last\_active\_at, open\_count |
| business\_hours | id, tenant\_id, timezone, weekly\_json, holidays\[\] |
| assignment\_log | id, tenant\_id, conversation\_id, from\_owner, to\_owner, reason (rule, round\_robin, manual, sticky, timeout), rule\_id, created\_at |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| routing.conversation.queued | No agent available | Team Supervisor after queue SLA |
| routing.conversation.assigned | Agent assigned | Assignee (in-app, push) |
| routing.conversation.transferred | Manual transfer | New assignee |
| routing.agent.status\_changed | Status change | Live board (realtime) |
| routing.rule.disabled | Rule became invalid | Admins |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST/PATCH/DELETE | /teams, /teams/{id}/members | Manage teams |
| GET/PUT | /routing/rules | Read or replace ordered rule set (versioned) |
| POST | /routing/rules/test | Preview routing against recent conversations |
| PUT | /me/status | Set own availability |
| PUT | /agents/{id}/status | Supervisor sets status |
| POST | /conversations/{id}/transfer | Transfer with note |
| GET | /routing/board | Live board snapshot (then WS updates) |
| GET/PUT | /business-hours | Schedules and holidays |

## Module 4: AI Chatbot (Sales Agent)

The AI answers product, price, stock and delivery questions in Bangla, English and Banglish, and builds draft orders, using only facts it fetched through typed tools. It never commits money, stock or order status by itself. MVP ships Draft and Supervised modes; Automatic mode unlocks per tenant after the pilot, once that tenant's eval pass rate is met.

### Modes

| Mode | What the AI does | Who sends |
| --- | --- | --- |
| Off | Nothing; summaries only if enabled | Humans |
| Draft | Writes a suggested reply in the composer | Human reviews and sends |
| Supervised | Sends low-risk intents automatically (greeting, price, availability, delivery fee); drafts the rest | Mixed, per intent allowlist |
| Automatic | Sends all replies except escalation intents; creates draft orders | AI, with human takeover at any time |

### Model choice

- **Intent, language and risk classification:** Claude Haiku 5.5 (fast, cheap, runs on every inbound burst).
- **Sales conversation with tool use:** Claude Sonnet 5.5.
- **Offline evaluation and test-case grading:** Claude Opus 5.5 (not in the live path).
- Model names live in config per agent version, so upgrades go through the test suite, not code changes.

### UI screens

| Screen | Contents |
| --- | --- |
| Agent settings | Persona, tone, language, mode, intent allowlist, handoff rules, budget cap |
| Sandbox | Chat with the draft agent as a test customer; see tool calls and validator result per reply |
| Test suite | Scenarios with expected outcomes, pass/fail per version, publish button |
| Versions | History, diff of settings, rollback |
| AI activity log | Runs per conversation: tools, tokens, cost, outcome, feedback |
| In-thread AI panel | Draft reply, confidence, sources used, rewrite/translate actions, take over button |

### User flows

**Flow 4.1 — Set up the agent (Admin)**

1. Admin opens AI Agent → sets name, persona, tone, language preference, emoji use, reply length.
2. Reviews data sources: catalog (live), knowledge base articles, delivery zones and fees, payment methods, return policy.
3. Picks mode and the Supervised allowlist of intents.
4. Sets handoff rules: always hand off for complaints, refunds, abusive messages, or after 2 failed answers.
5. Sets budget cap (monthly AI spend or conversations); behaviour at cap: fall back to Draft mode or Off.
6. Runs the sandbox test suite; publishing requires all critical tests to pass. Publishing creates an immutable agent version.

**Flow 4.2 — Live reply (Supervised or Automatic)**

1. Inbound message arrives; AI job is scheduled with a debounce (default 8 s after the latest customer message, max 20 s).
2. When the job runs, it checks: conversation still AI-owned, AI enabled, within budget, within the channel window. Any failure → stop.
3. Classifier (Haiku) returns language, intents, risk flags. Escalation intents → handoff (Flow 4.3).
4. Sales model (Sonnet) gets: system policy, agent version settings, last 20 messages, contact summary, retrieved knowledge snippets, and tool definitions.
5. Model calls tools (product search, stock check, delivery fee, order draft) and writes a reply.
6. The model writes prices and totals only as placeholders such as {{price:variant\_id}} and {{total:draft\_id}}; the server fills them from this turn's tool results. The validator then checks that no raw currency amount remains (after normalising Bangla digits), no discount is offered, links are on the allowlist, and length and language are OK.
7. Re-check ownership (a human may have taken over during generation). If still AI-owned, send; otherwise discard.
8. Store the run: model, tokens, cost, latency, tool calls, validator result.

**Flow 4.3 — Handoff to human**

1. Triggers: escalation intent, customer asks for a person, two low-confidence answers in a row, validator fails twice, tool error, or out-of-scope request.
2. AI sends a short holding message (“Amar ekjon team member apnake ekhuni help korben”) if within window and allowed.
3. Conversation ownership moves to routing (Module 3) with a handoff reason and an AI summary as an internal note.

**Flow 4.4 — Draft order in chat**

1. Customer chooses a product; AI confirms variant (size, colour) via stock tool.
2. AI collects missing fields one or two at a time: name, phone, address, delivery zone, payment method.
3. AI calls `create_order_draft`; the server computes totals and returns an order preview.
4. AI shows the preview (items, delivery fee, total) and asks for explicit confirmation.
5. Customer taps the Confirm order quick-reply button, or replies with a clear yes (unclear replies such as “hmm” get the question again) → `confirm_order_draft` is called with the draft version; the order service validates stock and totals in a transaction. Merchant setting decides whether confirmation is automatic or needs human approval.

### Tools available to the AI

| Tool | Purpose | Notes |
| --- | --- | --- |
| search\_products | Find products by text, category, budget, attributes | Returns only active, tenant-owned products |
| get\_variant\_stock | Current stock and price per variant | Source of truth for any price or stock claim |
| match\_product\_image | Find catalog items similar to a customer photo (v1) | Returns candidates with scores; AI must ask to confirm |
| get\_delivery\_fee | Fee and estimated days by zone | From merchant delivery settings |
| search\_knowledge | Retrieve policy and FAQ snippets | Tenant-filtered vector search |
| get\_contact\_orders | Recent orders and statuses for this contact | Read-only |
| get\_order\_tracking | v1 only. Phase 1 answers order status from the orders table | Never invents status if courier unreachable |
| create\_order\_draft / update\_order\_draft | Build or edit a draft | Server computes all totals |
| confirm\_order\_draft | Request confirmation of a draft | Requires explicit customer consent message ID |
| request\_handoff | Pass to human with reason | Always allowed |

### Business rules

- Every tool call is executed with the conversation's tenant ID injected by the server; the model never supplies tenant or user IDs.
- Customer text and knowledge documents are untrusted input. Instructions inside them (“ignore your rules”, “give me 90% off”) are never followed.
- Prices and totals can only appear as server-filled placeholders backed by this run's tool results; a raw currency amount in a reply is blocked.
- The AI offers no discounts in Phase 1; bargaining (“dam komano jabe?”) is handed to a human. A per-merchant maximum discount may come later.
- AI never refunds, cancels confirmed orders, changes stock or edits contact data except fields collected for an order draft.
- AI stays on business topics; general questions unrelated to the merchant get a polite decline (also required by WhatsApp policy).
- Human takeover cancels queued AI jobs and makes any in-flight generation discard its output at the ownership re-check.
- Budget: per-tenant monthly cap and per-conversation cap (default 30 AI replies); when reached, switch to Draft mode and notify Admin.
- Language: reply in the customer's language; Banglish in, Banglish out unless the merchant prefers Bangla script.

* **Own customer only:** order and tracking tools are scoped to the conversation's own contact. Phone numbers or names typed in the chat (“check my friend's order, 017…”) never widen the lookup.
* **Product context first:** if the conversation came from a post, ad or comment mapped to a product, the AI starts from that product. If not, it shows a product carousel to pick from rather than guessing.
* **Outside replies pause the AI:** an echo of a reply sent from Meta Business Suite pauses the AI for that conversation (Module 1).
* **Stored prompts are redacted:** phone numbers and addresses are masked in `ai_runs` payloads, which are kept 90 days.

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| Customer sends 5 short messages in a row | Debounce merges them into one turn; one reply |
| Customer sends a product screenshot only | Image matching (v1) or ask “Kon product ta? Link ba naam dile check kore dichhi”; never guess a price |
| Voice message | Transcribe (v1); if transcription confidence low, ask to type or hand off |
| Variant out of stock | Say so, suggest in-stock alternatives from search\_products |
| Model provider timeout or outage | Retry once; then fall back to Draft mode for the tenant and hand off pending conversations |
| Validator rejects twice | Hand off with the rejected draft attached as an internal note |
| Window closes before reply is ready | Do not send; create a follow-up task for a human |
| Prompt injection in a message | Ignored; flagged in the run log; repeated attempts raise risk flag |
| Customer mixes order for two people | Supports multiple line items, one address per order; second address → second draft |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| Edit agent settings and publish versions | Yes | Yes | No | No | No | No |
| Change mode or pause AI tenant-wide | Yes | Yes | Yes | No | No | No |
| Use AI drafts, rewrite, translate | Yes | Yes | Yes | Yes | Yes | No |
| Take over / hand back | Yes | Yes | Yes | Yes | No | No |
| Run sandbox tests | Yes | Yes | Yes | No | No | No |
| View AI run logs and costs | Yes | Yes | Yes | No | No | Yes |

### Data entities

| Entity | Key fields |
| --- | --- |
| ai\_agent | id, tenant\_id, name, active\_version\_id, mode, status |
| ai\_agent\_version | id, tenant\_id, agent\_id, settings\_json (persona, tone, models, allowlists, handoff rules), knowledge\_snapshot\_id, published\_by, published\_at, test\_report\_id |
| ai\_run | id, tenant\_id, conversation\_id, agent\_version\_id, trigger\_message\_ids, model, input\_tokens, output\_tokens, cost\_minor, latency\_ms, outcome (sent, drafted, discarded, handed\_off, failed), validator\_result |
| ai\_tool\_call | id, tenant\_id, run\_id, tool, args\_json, result\_json, duration\_ms, error |
| ai\_feedback | id, tenant\_id, run\_id, user\_id, rating (correct, partial, wrong, unsafe), correction\_text |
| ai\_budget | tenant\_id, period, cap\_minor, used\_minor, conversations\_used |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| ai.reply.sent | AI reply delivered | Thread viewers (realtime) |
| ai.reply.drafted | Draft ready in composer | Owner of conversation |
| ai.handoff.requested | Handoff triggered | Routing + Supervisor |
| ai.validator.failed | Reply blocked | Logged; Admin digest |
| ai.budget.threshold | 80% and 100% of cap | Owner and Admins (in-app, email) |
| ai.provider.degraded | Error rate above threshold | Platform admin; affected tenants see banner |
| ai.agent.published | New version live | Admins |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET/PATCH | /ai/agent | Agent settings (draft version) |
| POST | /ai/agent/versions | Publish a version (requires passing test report) |
| POST | /ai/agent/versions/{id}/rollback | Roll back to a version |
| PUT | /ai/agent/mode | Change mode or pause |
| POST | /conversations/{id}/ai/draft | Generate a draft on demand |
| POST | /ai/assist | Rewrite, translate, shorten, summarize text |
| POST | /ai/sandbox/runs | Run a test conversation |
| GET | /ai/runs?conversation\_id= | Run logs with tool calls |
| POST | /ai/runs/{id}/feedback | Rate an AI reply |
| GET | /ai/usage | Spend and volume against budget |

## Module 5: Broadcast Campaigns

Broadcasts send one approved message to a segment, and only to contacts the platform rules allow. In practice that means WhatsApp templates to opted-in contacts; Messenger and Instagram allow promotional sends only inside the 24-hour window, so they are limited to recent engagers. Ships in v1.

### Channel eligibility for broadcasts

| Channel | Who can receive | Message type |
| --- | --- | --- |
| WhatsApp | Contacts with marketing opt-in and no opt-out | Approved marketing or utility template |
| Messenger | Contacts whose last message was under 24 h ago | Any message, promotional allowed in window |
| Instagram | Contacts whose last message was under 24 h ago | Any message in window |
| Website widget | Not supported (visitors are not reachable later) | — |

Meta's paid sponsored messages and Click-to-Messenger/WhatsApp ads are outside this module; they run in Meta Ads Manager.

### User flows

**Flow 5.1 — Create a WhatsApp broadcast**

1. User picks channel account and an approved template; preview shows its category and the estimated cost per message.
2. Picks audience: a saved segment, tags, or an uploaded CSV of existing contacts (CSV phones must match contacts with opt-in; others are skipped and listed).
3. Maps template variables to contact fields or fixed values; previews 3 random recipients.
4. System computes the eligible count: opted in, not opted out, not in suppression list, not messaged by a campaign in the last N days (frequency cap), valid WhatsApp number.
5. Shows eligible count, excluded count by reason, estimated Meta cost, and whether it fits the remaining portfolio messaging limit for 24 h.
6. Schedule: send now or at a time in tenant timezone; respects quiet hours (default 21:00–09:00).
7. Approval: if the tenant requires it, an Admin approves before scheduling.
8. During send: progress bar (queued, sent, delivered, read, failed), pause and cancel.
9. After: results report with replies and attributed orders.

**Flow 5.2 — Messenger / Instagram in-window broadcast**

1. Audience is built only from contacts with last inbound under 24 h (computed at send time, not at creation).
2. Content is free-form (text, image, product card).
3. Contacts whose window closes before their turn in the queue are skipped, never sent with a tag.

**Flow 5.3 — Opt-out**

1. Customer replies STOP, “bondho koro”, “message diben na”, or taps an opt-out button.
2. Keyword or button match (plus AI intent) sets marketing consent to opted-out for that channel; confirmation message sent if window allows.
3. Contact is excluded from all future broadcasts on that channel immediately, including campaigns already queued.

### UI screens

| Screen | Contents |
| --- | --- |
| Campaign list | Name, channel, status, audience size, sent, delivered, read, replies, orders, cost |
| Campaign builder | Channel, template/content, audience, variables, schedule, eligibility summary, cost estimate |
| Approval view | Preview, audience summary, approve/reject with note |
| Live send view | Progress, pause, cancel, error breakdown |
| Results report | Funnel, replies, orders and revenue with attribution window, opt-outs |
| Suppression list | Phone numbers and contacts never to message, with reason |

### Business rules

- Eligibility is checked twice: at scheduling (estimate) and per recipient at send time (authoritative).
- Marketing consent is per channel, with source and timestamp; ordering or chatting does not imply marketing consent.
- Default frequency cap: one marketing broadcast per contact per 3 days per channel (tenant can lower, not remove).
- Send rate stays under the channel's throughput and under the portfolio messaging limit; if the limit would be exceeded, the remainder waits for the next 24 h window and the user is told.
- Every recipient gets a `campaign_recipient` row with a unique key, so retries and restarts never double-send.
- A template paused or disabled by Meta pauses all campaigns using it.
- Campaign cost estimate uses the current rate card for the recipient country and category; actual cost is reconciled from status webhook pricing data.
- Attribution: an order is attributed to a campaign if the contact replied to or clicked from it and ordered within the attribution window (default 72 h). The method is shown on the report.

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| 5,000 recipients but portfolio limit 2,000 | Sends 2,000, holds the rest, resumes after the rolling window; user warned before scheduling |
| Many failures from one cause (template paused, token invalid) | Auto-pause after 5% failure rate or 50 consecutive failures; alert creator |
| Contact opts out while campaign is running | Skipped at send time |
| Customer replies to broadcast | Opens a normal conversation routed to AI or a team; linked to campaign |
| Campaign scheduled during quiet hours | Rejected at scheduling with next allowed time suggested |
| Duplicate contacts in CSV | Deduplicated by contact; one message each |
| Worker crash mid-send | Resumes from recipients still in queued state |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| Create and edit drafts | Yes | Yes | Yes | No | No | No |
| Approve and schedule | Yes | Yes | If allowed | No | No | No |
| Pause / cancel | Yes | Yes | Yes | No | No | No |
| View reports | Yes | Yes | Yes | No | No | Yes |
| Manage suppression list | Yes | Yes | No | No | No | No |

### Data entities

| Entity | Key fields |
| --- | --- |
| campaign | id, tenant\_id, name, channel\_account\_id, template\_id, content\_json, segment\_id, status (draft, pending\_approval, scheduled, sending, paused, completed, cancelled), scheduled\_at, quiet\_hours, created\_by, approved\_by, attribution\_window\_hours |
| campaign\_recipient | id, tenant\_id, campaign\_id, contact\_id, contact\_identity\_id, status (queued, skipped, sent, delivered, read, failed, replied), skip\_reason, message\_id, cost\_minor |
| marketing\_consent | id, tenant\_id, contact\_id, channel, status (opted\_in, opted\_out), source, captured\_at, evidence\_message\_id |
| suppression\_entry | id, tenant\_id, value (phone or contact\_id), reason, created\_by |
| campaign\_attribution | tenant\_id, campaign\_id, order\_id, contact\_id, method |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| campaign.submitted\_for\_approval | Draft submitted | Approvers |
| campaign.started / campaign.completed | Sending begins or ends | Creator |
| campaign.auto\_paused | Failure threshold or template paused | Creator and Admins (in-app, email) |
| campaign.limit\_deferred | Messaging limit reached | Creator |
| contact.marketing\_opted\_out | Opt-out recorded | Logged; included in report |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST/PATCH | /campaigns | List, create, edit drafts |
| POST | /campaigns/{id}/estimate | Eligible count, exclusions, cost, limit check |
| POST | /campaigns/{id}/submit, /approve, /reject | Approval flow |
| POST | /campaigns/{id}/schedule, /pause, /resume, /cancel | Lifecycle |
| GET | /campaigns/{id}/recipients | Per-recipient status with filters |
| GET | /campaigns/{id}/report | Results and attribution |
| GET/POST/DELETE | /suppression | Suppression list |
| PUT | /contacts/{id}/consent | Record consent change with source |

## Module 6: Contacts & CRM

Each real customer gets one contact record that collects their channel identities, phone, addresses, orders, delivery history and consent. Identities merge only on verified evidence, never on matching names. MVP ships profiles, timeline, tags, notes and basic segments; v1 adds merge suggestions, COD risk score and advanced segments.

### User flows

**Flow 6.1 — Automatic contact creation**

1. First inbound message from an unknown channel identity creates a contact with the profile name and avatar the channel provides.
2. If the platform shares nothing more, the contact has only that identity until the customer gives a phone or order details.

**Flow 6.2 — Phone capture and linking**

1. Phone is captured from an order draft, the widget form, or WhatsApp (the wa\_id is a verified phone).
2. Phone is normalized to E.164 (+8801XXXXXXXXX), rejecting invalid BD mobile prefixes.
3. If another contact already has this verified phone, the system creates a merge suggestion, not an automatic merge, unless the phone was verified by OTP or comes from WhatsApp (tenant setting allows auto-merge for those).

**Flow 6.3 — Merge contacts**

1. Agent opens a merge suggestion; sees both profiles side by side with evidence (same verified phone, same address, order history).
2. Picks the primary record; conflicting fields default to the most recent verified value.
3. Merge moves identities, conversations, orders, notes and tags to the primary; secondary becomes a redirect stub; action is audited and can be undone within 7 days.

**Flow 6.4 — View a customer (agent in inbox)**

1. Right panel shows: name, phone, channels, tags, lifetime orders and value, delivery success rate, last order status, notes, consent.
2. Timeline tab merges messages, orders, shipments, returns, notes and campaign touches in time order.
3. Agent adds tags or a note, edits address, or starts a draft order.

**Flow 6.5 — Build a segment**

1. User combines filters: tags, channel, last order date, order count, lifetime value, delivery success rate, product category bought, consent status, location (district).
2. Live count updates; segment saved as dynamic (re-evaluated at use) or static snapshot.

**Flow 6.6 — Data request**

1. Admin receives a customer request to export or delete their data.
2. Export produces a file of profile, messages and orders; delete anonymizes the contact, deletes messages and media, and keeps order financial rows with personal fields removed.

### UI screens

| Screen | Contents |
| --- | --- |
| Contacts list | Search, filters, columns (name, phone, channels, orders, LTV, last seen, tags), bulk tag, export |
| Contact profile | Header, identities, addresses, tags, consent, stats, timeline, notes, orders |
| Merge suggestions | Queue of suggested pairs with evidence; merge / dismiss |
| Segments | List, builder with live count, used-in (campaigns) |
| Import | CSV upload, column mapping, validation report, consent source required |
| Inbox side panel | Compact profile used in Module 1 |

### Business rules

- Never auto-merge on name, unverified phone typed in chat, or address alone.
- A contact may have many identities, addresses and phones; one phone and one address are marked default.
- **Delivery success rate** = delivered orders ÷ (delivered + returned + failed) for that contact across the tenant; shown with the count, for example 4/5. Contacts with fewer than 2 completed orders show “new”.
- **COD risk flag (v1):** contacts with low delivery success, or with prior cancellations after shipping, are flagged; the merchant chooses whether flagged orders require advance delivery fee. Cross-merchant data sharing is not done unless the merchant enables a vetted courier fraud-check service.
- Imported contacts must carry a consent source to be eligible for broadcasts.
- Notes are internal and never visible to customers.
- Exports include only fields the user's role may see and are logged.

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| Two family members share one phone | Merge suggestion shows different names and addresses; agent dismisses; dismissal remembered |
| Customer changes phone number | Add new phone, keep old as inactive; history stays |
| Contact deleted while conversation open | Conversation closed; new inbound creates a fresh contact |
| Import with 10,000 rows, 300 invalid | Valid rows imported; downloadable error file for the rest |
| Merge undone after new messages arrived | New items stay with the record they arrived on; undo is blocked after 7 days |
| Phone in a chat message that is not the customer's (gift order) | Saved as recipient phone on the order address, not as the contact's phone |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| View contacts | Yes | Yes | Yes | Assigned + team | For their orders | Aggregates only |
| Edit profile, tags, notes | Yes | Yes | Yes | Yes | Addresses | No |
| Merge / unmerge | Yes | Yes | Yes | No | No | No |
| Import / bulk edit | Yes | Yes | No | No | No | No |
| Export | Yes | Yes | No | No | No | If granted |
| Delete / anonymize | Yes | Yes | No | No | No | No |
| Manage segments | Yes | Yes | Yes | No | No | Yes |

### Data entities

| Entity | Key fields |
| --- | --- |
| contact | id, tenant\_id, display\_name, primary\_phone\_id, default\_address\_id, language, tags\[\], lifetime\_orders, lifetime\_value\_minor, delivered\_count, returned\_count, risk\_flag, first\_seen\_at, last\_seen\_at, merged\_into\_id, deleted\_at |
| contact\_identity | (Module 2) channel identities linked to the contact |
| contact\_phone | id, tenant\_id, contact\_id, e164, verified\_by (whatsapp, otp, none), is\_default, active |
| contact\_address | id, tenant\_id, contact\_id, recipient\_name, recipient\_phone, line1, area, thana, district, courier\_zone\_id, is\_default |
| contact\_note | id, tenant\_id, contact\_id, author\_id, body, created\_at |
| merge\_suggestion | id, tenant\_id, contact\_a, contact\_b, evidence\_json, status, decided\_by |
| merge\_log | id, tenant\_id, primary\_id, secondary\_id, moved\_json, merged\_by, undone\_at |
| segment | id, tenant\_id, name, type (dynamic, static), filter\_json, member\_count\_cached |
| marketing\_consent | (Module 5) |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| contact.created | New contact | Analytics only |
| contact.merge\_suggested | Possible duplicate found | Supervisor queue (in-app badge) |
| contact.merged / contact.unmerged | Merge action | Audit log |
| contact.risk\_flagged | Risk rule matches | Order manager when an order is drafted for this contact |
| contact.data\_exported / contact.anonymized | Data request completed | Owner (audit) |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET/POST | /contacts | Search and create |
| GET/PATCH/DELETE | /contacts/{id} | Profile; DELETE anonymizes |
| GET | /contacts/{id}/timeline | Unified timeline with cursor |
| POST | /contacts/{id}/notes, /tags | Notes and tags |
| POST/PATCH | /contacts/{id}/phones, /addresses | Manage phones and addresses |
| POST | /contacts/{id}/phones/{pid}/verify | Send and check OTP |
| GET | /merge-suggestions | Queue |
| POST | /contacts/merge, /contacts/merge/{logId}/undo | Merge and undo |
| GET/POST/PATCH | /segments, /segments/{id}/count | Segments |
| POST | /contacts/import | CSV import job |
| POST | /contacts/{id}/export | Data export job |

## Module 7: Analytics

Analytics answers four merchant questions: how much did I sell, how fast does my team respond, how well does the AI perform, and which products and campaigns work. Every number states its definition, date range and timezone. MVP ships the Overview, Conversations and AI dashboards; v1 adds Products, Campaigns, Agents, scheduled reports and custom ranges beyond 90 days.

### Metric definitions

| Metric | Definition |
| --- | --- |
| Gross sales | Sum of confirmed order totals (incl. delivery fee) with confirmation date in range |
| Net revenue | Gross sales minus cancelled, returned and refunded amounts, by the date of the original confirmation |
| Orders | Count of orders confirmed in range |
| AOV | Gross sales ÷ orders |
| Conversion rate | Conversations with a confirmed order within 7 days ÷ conversations with a purchase-intent message, both started in range |
| Delivery success | Delivered ÷ (delivered + returned + failed) for shipments closed in range |
| First response time | Median time from first inbound message to first public reply (AI or human), business hours only, configurable |
| Resolution time | Median time from open to resolved |
| AI resolution rate | AI-owned conversations resolved or ordered without handoff ÷ AI-owned conversations |
| AI-assisted orders | Orders whose draft was created by the AI tool (explicit method, not inferred causality) |
| AI cost per order | AI spend in range ÷ AI-assisted orders |
| SLA breach rate | Conversations that breached first-response SLA ÷ conversations with an SLA |

### User flows

**Flow 7.1 — Check daily performance (Owner)**

1. Opens Overview: KPI cards (gross sales, orders, AOV, conversion, first response, AI-assisted orders) with change versus previous period.
2. Picks range: today, yesterday, 7, 30, 90 days, custom; timezone shown on the page.
3. Hovers an info icon on any KPI to read its definition and exclusions.
4. Clicks a KPI to drill into the list behind it (orders, conversations).

**Flow 7.2 — Review team performance (Supervisor)**

1. Opens Agents dashboard: per agent conversations handled, first response, resolution time, orders created, CSAT (v1).
2. Filters by team and channel; exports CSV.

**Flow 7.3 — Review AI quality (Admin)**

1. Opens AI dashboard: AI replies, handoffs by reason, validator blocks, feedback ratings, cost, latency.
2. Clicks a handoff reason to see sample conversations; marks replies for the test suite.

**Flow 7.4 — Scheduled report (v1)**

1. User picks a dashboard, frequency (daily 9:00, weekly Sunday), recipients within the workspace.
2. Email with PDF summary and a link back; recipients must be workspace members.

### UI screens

| Screen | Contents |
| --- | --- |
| Overview | KPI cards, sales trend line, orders by channel, top products, conversion funnel (conversations → purchase intent → draft → confirmed → delivered) |
| Conversations | Volume by channel and hour, response times, SLA breaches, busiest hours heatmap |
| AI performance | Replies, resolution rate, handoffs by reason, blocked replies, cost and latency trend |
| Products (v1) | Best sellers, most asked but low conversion, out-of-stock demand |
| Campaigns (v1) | Per campaign funnel and attributed revenue |
| Agents (v1) | Leaderboard and per-agent detail |
| Exports | CSV/XLSX for every table; PDF for dashboards |

### Business rules

- Dashboards read from pre-aggregated daily tables per tenant, refreshed every 5 minutes for today and nightly for history; raw tables are never scanned on page load.
- Days are bucketed in the tenant timezone; changing the timezone triggers a rebuild of aggregates.
- Every KPI shows its definition, denominator and exclusions; test orders and sandbox AI runs are excluded.
- Late events (an order cancelled after its day) update the original day; the page shows “data as of” time.
- Money is shown in tenant currency from minor units; no averages computed on rounded values.
- Agents see only their own stats unless they are Supervisor or above.

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| New tenant with no data | Empty states with a setup checklist, not zeros that look like failure |
| Aggregation job delayed | Banner “data as of 10:45”; numbers never silently stale |
| Order total edited after confirmation | Aggregates updated; audit shows the change |
| Range over 365 days | Monthly granularity; export runs as a background job and emails a link |
| Very small denominators | Rates shown with counts (for example 2/3) and flagged as low sample |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| Overview and sales | Yes | Yes | Yes | No | Orders only | Yes |
| Team and agent stats | Yes | Yes | Yes | Own only | No | Yes |
| AI performance and cost | Yes | Yes | Yes | No | No | Yes |
| Export | Yes | Yes | Yes | No | No | If granted |
| Scheduled reports | Yes | Yes | Yes | No | No | Yes |

### Data entities

| Entity | Key fields |
| --- | --- |
| metric\_daily | tenant\_id, date (tenant tz), dimension (channel, team, agent, product, campaign), dimension\_id, metric, value, updated\_at |
| analytics\_event | id, tenant\_id, type, occurred\_at, entity\_id, data\_json (fed from the outbox) |
| report\_schedule | id, tenant\_id, dashboard, frequency, recipients\[\], last\_sent\_at |
| export\_job | id, tenant\_id, requested\_by, type, params\_json, status, file\_key, expires\_at |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| analytics.aggregation.delayed | Refresh behind by over 15 min | Platform admin; tenant banner |
| analytics.export.ready | Export finished | Requester (in-app, email link, expires in 7 days) |
| analytics.report.sent | Scheduled report sent | Recipients |
| analytics.anomaly (v1) | Sales or response time far outside normal | Owner |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /analytics/overview?from=&to= | KPI cards with comparison |
| GET | /analytics/timeseries?metric=&interval= | Chart series |
| GET | /analytics/breakdown?metric=&dimension= | By channel, agent, product, campaign |
| GET | /analytics/funnel | Conversation-to-delivery funnel |
| GET | /analytics/definitions | Metric definitions shown in UI |
| POST | /analytics/exports | Start export job |
| GET/POST/DELETE | /analytics/schedules | Scheduled reports |

## Module 8: Billing

Billing sells monthly or annual plans in BDT, meters AI usage, and turns verified payment events into feature entitlements. Access is decided by the backend entitlement record, never by the frontend or a redirect URL. MVP ships plans, trial, one local payment gateway, invoices, AI usage metering and limits; v1 adds annual plans, add-on packs, coupons and dunning automation.

### Plan structure (illustrative, from the blueprint)

| Plan | Price (BDT/month) | Channels | Seats | AI conversations/month | Broadcasts |
| --- | --- | --- | --- | --- | --- |
| Trial (14 days) | 0 | 1 | 2 | 50 | No |
| Starter | 999 | 1 | 2 | 500 | No |
| Growth | 2,499 | 3 | 5 | 2,000 | Yes |
| Business | 5,999 | 10 | 15 | 6,000 | Yes |
| Enterprise | Custom | Custom | Custom | Custom | Yes |

Limits are placeholders until pilot data shows real AI cost per conversation. An “AI conversation” = one conversation with at least one AI reply or draft in a calendar day.

### Who pays for WhatsApp messages

The merchant owns their WhatsApp Business account through Embedded Signup and pays Meta directly for template messages with their own payment method in Meta Business. The platform shows estimates and actual costs from status webhooks but does not resell message credits in MVP.

### User flows

**Flow 8.1 — Start trial and subscribe**

1. New workspace starts a 14-day trial with Growth features but a 50 AI-conversation cap; AI replies start only after a Page is connected and the Owner's phone is verified; no card needed.
2. Billing page shows days left, usage against limits, and plan options.
3. Owner picks a plan and period, sees price incl. VAT, clicks Pay.
4. Redirect to the gateway (bKash, Nagad, cards via local gateway); payment completes.
5. Gateway webhook (verified signature, then server-side transaction validation call) marks the invoice paid and activates the subscription; the browser return URL only shows a “confirming payment” page that polls status.
6. Receipt emailed; entitlements updated within a minute.

**Flow 8.2 — Renewal**

1. 7 and 3 days before period end, Owner gets reminders with a pay link (most local wallets do not support automatic recurring charges; where the gateway supports saved tokens, auto-charge is offered).
2. Payment before period end extends the period from the old end date, not from payment date.

**Flow 8.3 — Failed or late payment (dunning)**

1. Period ends unpaid → status Past due; 7-day grace with full access and a banner.
2. Day 8 → Restricted: inbox read-only, AI and broadcasts stop, orders and contacts still viewable and exportable.
3. Day 30 → Suspended: login shows only billing and data export. Data retained 90 days, then deletion after warnings.
4. Payment at any stage restores full access immediately.

**Flow 8.4 — Upgrade, downgrade, cancel**

1. Upgrade: immediate; charge prorated difference for the rest of the period.
2. Downgrade: takes effect at next renewal; if usage exceeds the new limits (for example 5 channels on a 3-channel plan), Owner must choose which to keep before the date, otherwise the oldest stay active.
3. Cancel: stays active until period end; data export offered.

**Flow 8.5 — Hitting an AI limit**

1. At 80% of monthly AI conversations, Owner and Admins notified.
2. At 100%, AI switches to Draft mode only (drafts still count toward a soft overage of 10%) and offers an add-on pack or upgrade.
3. Hard spend cap set by the Owner is never exceeded.

### UI screens

| Screen | Contents |
| --- | --- |
| Plans and pricing | Plan comparison, current plan, upgrade/downgrade |
| Billing overview | Status, period, next payment date, usage meters (seats, channels, AI conversations), spend cap |
| Checkout confirmation | Waiting-for-confirmation page that polls payment status |
| Invoices | List, download PDF, payment method, VAT details |
| Billing details | Business name, address, TIN/BIN if any, billing email |
| Restricted / suspended banners | Clear reason and pay action, shown on every page |
| Super admin billing (platform) | MRR, past-due tenants, manual credit, refunds, plan overrides |

### Business rules

- Entitlements (seats, channels, AI quota, features) are computed server-side from the active subscription and checked on every relevant API call.
- Payment success comes only from a verified gateway webhook or a server-side validation API call; return URLs and client callbacks never activate anything.
- Each gateway transaction ID can settle at most one invoice (unique constraint); duplicate webhooks are no-ops.
- Usage is recorded as append-only `usage_event` rows with an idempotency key; counters are derived and reconciled nightly.
- Prices stored in poisha; invoices are immutable after issue; corrections are credit notes.
- VAT and invoice format follow Bangladesh rules to be confirmed with an accountant before launch.
- Downgrade or suspension never deletes data; deletion only after the retention period with at least 3 warnings.
- Manual adjustments by platform admins require a reason and are audited.

### Edge cases and failure states

| Situation | Expected behaviour |
| --- | --- |
| Customer paid but webhook delayed | Confirmation page polls; background job queries the gateway every minute for pending transactions up to 24 h |
| Payment captured twice | Second transaction flagged for refund; only one invoice paid |
| Gateway outage | Show alternative method; extend grace if outage spans renewal |
| Refund issued on the gateway | Webhook reverses the invoice status; entitlement adjusted per refund policy |
| Seat removed mid-period | Capacity freed immediately; no partial refund (MVP) |
| Clock/timezone edge at period end | Periods computed in UTC instants; displayed in tenant timezone |
| Workspace exceeds channel limit after downgrade | Extra channels disconnected at renewal per Owner's choice; history kept |

### Permissions

| Action | Owner | Admin | Supervisor | Agent | Order manager | Analyst |
| --- | --- | --- | --- | --- | --- | --- |
| View plan and usage | Yes | Yes | Usage only | No | No | No |
| Change plan, pay, cancel | Yes | If granted billing.manage | No | No | No | No |
| Download invoices | Yes | Yes | No | No | No | No |
| Set AI spend cap | Yes | Yes | No | No | No | No |
| Platform credits, refunds, overrides | Platform admin only |  |  |  |  |  |

### Data entities

| Entity | Key fields |
| --- | --- |
| plan | id, code, name, price\_minor, currency, period, limits\_json, features\_json, active |
| subscription | id, tenant\_id, plan\_id, status (trialing, active, past\_due, restricted, suspended, cancelled), current\_period\_start, current\_period\_end, cancel\_at\_period\_end, pending\_plan\_id |
| invoice | id, tenant\_id, subscription\_id, number, lines\_json, subtotal\_minor, vat\_minor, total\_minor, status (draft, open, paid, void, refunded), issued\_at, paid\_at |
| payment | id, tenant\_id, invoice\_id, gateway, gateway\_txn\_id (unique), amount\_minor, status, raw\_payload, verified\_at |
| entitlement | tenant\_id, key, limit, source (plan, addon, override), valid\_until |
| usage\_event | id, tenant\_id, meter (ai\_conversation, seat, channel, broadcast\_recipient), quantity, idempotency\_key (unique), occurred\_at |
| usage\_counter | tenant\_id, meter, period, used |
| billing\_profile | tenant\_id, legal\_name, address, tax\_ids, billing\_email |

### Events and notifications

| Event | Triggered when | Notifies |
| --- | --- | --- |
| billing.trial.ending | 3 days and 1 day before trial end | Owner (email, in-app) |
| billing.invoice.created | Renewal invoice issued | Owner, billing email |
| billing.payment.succeeded | Verified payment | Owner (receipt email) |
| billing.payment.failed | Gateway failure | Owner |
| billing.subscription.past\_due / restricted / suspended | Status change | Owner and Admins (email, in-app, push) |
| billing.usage.threshold | 80% and 100% of a meter | Owner and Admins |
| billing.plan.changed | Upgrade, downgrade, cancel | Owner; audit |

### APIs

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /billing/plans | Public plan list |
| GET | /billing/subscription | Current plan, status, period |
| GET | /billing/usage | Meters against limits |
| POST | /billing/checkout | Create invoice and gateway session (Idempotency-Key required) |
| GET | /billing/payments/{id}/status | Polled by confirmation page |
| POST | /webhooks/payments/{gateway} | Verified gateway callbacks |
| POST | /billing/subscription/change | Upgrade or schedule downgrade |
| POST | /billing/subscription/cancel | Cancel at period end |
| GET | /billing/invoices, /billing/invoices/{id}/pdf | Invoices |
| PUT | /billing/profile, /billing/spend-cap | Billing details and AI spend cap |
| GET | /entitlements | Effective limits for the frontend to display |

## Open questions and facts to re-verify

The items below decide scope or cost and need an answer before the related module is built.

- [ ] **WhatsApp service-message charges.** Some WhatsApp partners report Meta began charging for free-form service replies and in-window utility templates on 1 Oct 2026 ([ChakraHQ](https://chakrahq.com/article/whatsapp-api-pricing-update-service-messages-october-2026)). Meta's own [pricing page](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) still listed non-template messages as free on 9 Oct 2026. Confirm in WhatsApp Manager before finalizing AI reply design and plan pricing; if charged, the debounce and “one message per reply” rules in Module 4 become cost controls.
- [ ] **Bangladesh WhatsApp rates.** Meta's pricing page says Bangladesh moves to its own rate card on 1 Oct 2026 with lower utility and authentication rates; pull the actual rates for campaign cost estimates.
- [ ] **Meta App Review.** Which permissions (pages\_messaging, Instagram messaging and comments, HUMAN\_AGENT feature) need Advanced Access, and expected review time; business verification of your company.
- [ ] **Payment gateway.** Which gateway for subscriptions (for example SSLCommerz, bKash, Nagad aggregator), whether it supports saved-token recurring charges, and settlement timelines.
- [ ] **VAT and invoicing.** VAT rate and invoice format for a BD SaaS selling to local merchants; whether international card customers change this.
- [ ] **Plan limits.** Replace placeholder AI conversation limits with pilot data: average AI cost per conversation in Bangla/Banglish.
- [ ] **Data protection.** Retention periods for messages and media, and obligations under current Bangladesh data protection law; get local legal advice.
- [ ] **Courier fraud-check.** Whether to integrate a courier's customer delivery-history service for the COD risk flag, and its data-sharing terms.
- [ ] **Team size and dates.** Phase dates depend on team size; add them once known.

All Meta and WhatsApp figures in this document were checked on 9 Oct 2026 and are linked in Module 2.
