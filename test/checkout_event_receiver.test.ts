import assert from "node:assert/strict";
import test from "node:test";
import { hasValidSignature, nextTenantState, signatureFor } from "../src/checkout_event_receiver.ts";

test("a suspended storefront account stays out of checkout even with a valid event signature", () => {
  const rawBody = JSON.stringify({
    id: "evt_42",
    type: "account.suspended",
    tenant_id: "shop_elm",
    occurred_at: "2026-09-14T09:00:00Z"
  });
  const secret = "local-checkout-secret";
  assert.equal(hasValidSignature(rawBody, signatureFor(rawBody, secret), secret), true);
  assert.equal(hasValidSignature(rawBody, [signatureFor(rawBody, secret)], secret), false);
  assert.equal(nextTenantState(JSON.parse(rawBody)), "suspended");
});
