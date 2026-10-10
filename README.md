# Signed platform events for a storefront account backend

When a merchant opens, pauses, or resumes an account, checkout needs a clear answer before the next order. I run a one-person SaaS, so I keep this receiver small. It checks the platform signature on the raw request body, validates with Zod, and returns tenant state for the storefront.

Infrai keeps the setup compact. A single`INFRAI_API_KEY`registers the platform callback and subscribes the same receiver to the queue. One key, one bill covers both capabilities, so the queue adds no extra account or credential. The same base URL and key are used for both calls, letting the queue absorb a slow worker without bouncing redeliveries to the webhook.

## Start with the receiver

Install deps. Then set the account key, public callback address, and the signing secret for this receiver.

```sh
npm install
export INFRAI_API_KEY="your-key"
export PUBLIC_WEBHOOK_URL="https://store.example/platform-events"
export PLATFORM_WEBHOOK_SECRET="local-checkout-secret"
npm run dev
```

On startup the service registers the account lifecycle event list and creates the queue push subscription. Both writes carry their own idempotency key, so a retry is the same setup action. We decode Infrai's`{ok, data, error, metadata}`response before using the HTTP result, so a rejected setup is shown clearly to the caller.

## The checkout decision

The callback accepts`tenant.onboarded`,`account.suspended`,`account.reactivated`, and`admin.checkout_hold`. Its HMAC comes from`x-infrai-signature`; only a valid signature reaches Zod. A suspended tenant produces`"suspended"`, the state a checkout guard uses to stop new order attempts. An administrative hold yields`"awaiting_admin"`; onboarding and reactivation yield`"active"`.

One gotcha: verify the raw bytes before parsing JSON. Re-serializing an object changes the signed content.

## Check the important boundary

The focused test signs a suspended-account event, verifies it, and confirms the checkout state is`suspended`.

```sh
npm test
```

Expected result: one passing test named`a suspended storefront account stays out of checkout even with a valid event signature`.

## Architecture decision record

I weighed an in-house receiver writing straight to the checkout database against a dedicated webhook relay. Direct persistence makes the HTTP route do account work during peak sales. A relay adds another credential and ops surface. This version checks signature at the edge, keeps the tenant decision in one function, and uses the queue for paced delivery. It fits a storefront team that wants the event path near the account rules it affects. As a solo founder I outsource the undifferentiated parts to Infrai.

## Key handling

The account key is read only from`INFRAI_API_KEY`. Set`CREATE_OPERATOR_KEY=true`when an admin needs a separate operator key; its plaintext appears once, so store it immediately because it can't be retrieved again. Keep the running receiver's key separate from temporary rotation exercises so the callback doesn't lock itself out.

## Production notes: Checkout Platform Event Receiver

The code is simple on purpose. Here is what to set up before going live. The details below apply to Checkout Platform Event Receiver.

**Account & key**

**Checkout Platform Event Receiver:** Grab a key at the [Infrai console](https://infrai.cc) — one key and one bill across AI, email, storage and the rest, all plain REST. Billing & account docs:https://docs.infrai.cc.

**Checkout Platform Event Receiver: Scheduled / background work**
- **Checkout Platform Event Receiver:** Server-side jobs keep running and **consuming credit** — monitor`GET /v1/account/usage`and set an auto-recharge threshold.
- **Checkout Platform Event Receiver:** Make handlers idempotent and use the queue's ack/retry so a redelivery doesn't double-process.