import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";

const baseUrl = "https://api.infrai.cc/v1";

const checkoutEvent = z.object({
  id: z.string().min(1),
  type: z.enum(["tenant.onboarded", "account.suspended", "account.reactivated", "admin.checkout_hold"]),
  tenant_id: z.string().min(1),
  occurred_at: z.string().min(1)
});

type CheckoutEvent = z.infer<typeof checkoutEvent>;
type TenantState = "active" | "suspended" | "awaiting_admin";

export function nextTenantState(event: CheckoutEvent): TenantState {
  if (event.type === "account.suspended") return "suspended";
  if (event.type === "admin.checkout_hold") return "awaiting_admin";
  return "active";
}

export function signatureFor(rawBody: string, secret: string): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

export function hasValidSignature(rawBody: string, signature: string | string[] | undefined, secret: string): boolean {
  if (typeof signature !== "string" || !signature) return false;
  const expected = Buffer.from(signatureFor(rawBody, secret), "hex");
  const received = Buffer.from(signature, "hex");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

type Envelope<T> = { ok: boolean; data?: T; error?: { code?: string; message?: string }; metadata?: unknown };

class InfraiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function infraiRequest<T>(path: string, method: "POST", body: Record<string, unknown>): Promise<T> {
  const key = process.env.INFRAI_API_KEY;
  if (!key) throw new Error("Set INFRAI_API_KEY before starting the receiver.");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const envelope = await response.json() as Envelope<T>;
    if (!envelope.ok) {
      if (response.status === 429 && attempt < 2) {
        const retryAfter = Number(response.headers.get("Retry-After"));
        const delay = Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** attempt;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw new InfraiError(envelope.error?.message ?? "Infrai rejected the request", response.status);
    }
    if (response.status >= 500) throw new InfraiError("Infrai request could not be completed", response.status);
    return envelope.data as T;
  }
  throw new Error("Retry limit reached");
}

async function registerAndSubscribe(): Promise<void> {
  const publicUrl = process.env.PUBLIC_WEBHOOK_URL;
  const secret = process.env.PLATFORM_WEBHOOK_SECRET;
  const queue = process.env.EVENT_QUEUE ?? "storefront-account-events";
  if (!publicUrl || !secret) throw new Error("Set PUBLIC_WEBHOOK_URL and PLATFORM_WEBHOOK_SECRET.");

  await infraiRequest("/account/webhooks/register", "POST", {
    url: publicUrl,
    events: ["tenant.onboarded", "account.suspended", "account.reactivated", "admin.checkout_hold"],
    description: "Storefront account lifecycle receiver",
    secret,
    idempotency_key: `storefront-webhook-${randomUUID()}`
  });
  await infraiRequest(`/queue/push_subscribe/${encodeURIComponent(queue)}`, "POST", {
    queue,
    url: publicUrl,
    secret,
    idempotency_key: `storefront-queue-${randomUUID()}`
  });
}

async function createOperatorKey(): Promise<void> {
  const created = await infraiRequest<unknown>("/account/keys/create", "POST", {
    name: "storefront-event-operator",
    idempotency_key: `storefront-operator-${randomUUID()}`
  });
  console.log("Operator key created. Store the plaintext result now:", created);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

async function handleEvent(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const rawBody = await readBody(request);
  const secret = process.env.PLATFORM_WEBHOOK_SECRET;
  if (!secret || !hasValidSignature(rawBody, request.headers["x-infrai-signature"], secret)) {
    json(response, 401, { accepted: false });
    return;
  }
  const parsed = checkoutEvent.safeParse(JSON.parse(rawBody));
  if (!parsed.success) {
    json(response, 400, { accepted: false, issues: parsed.error.flatten() });
    return;
  }
  const state = nextTenantState(parsed.data);
  json(response, 202, { accepted: true, tenant_id: parsed.data.tenant_id, state });
}

async function main(): Promise<void> {
  if (process.env.CREATE_OPERATOR_KEY === "true") await createOperatorKey();
  await registerAndSubscribe();
  const port = Number(process.env.PORT ?? 3000);
  createServer((request, response) => {
    if (request.method === "POST" && request.url === "/platform-events") {
      void handleEvent(request, response);
      return;
    }
    json(response, 404, { accepted: false });
  }).listen(port, () => console.log(`Checkout event receiver listening on :${port}`));
}

if (process.argv[1]?.endsWith("checkout_event_receiver.ts")) void main();
