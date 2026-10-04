import DodoPayments from "dodopayments";
import type { ConsoleSubscription, Organization } from "../domain/types.js";
import type { Store } from "../persistence/store.js";
import { AppError } from "../shared/errors.js";

// Agent Governance console plans, sold through Dodo Payments (merchant of record). Webhooks are the
// source of truth for a workspace's plan; the free plan needs no record at all.

export type PlanId = "free" | "team" | "business";

export interface Plan {
  id: PlanId;
  name: string;
  priceUsdMonthly: number;
  activeCertificates: number;
  summary: string;
}

export const PLANS: Record<PlanId, Plan> = {
  free: { id: "free", name: "Trial", priceUsdMonthly: 0, activeCertificates: 2, summary: "Explore the console with up to 2 active agent certificates." },
  team: { id: "team", name: "Team", priceUsdMonthly: 249, activeCertificates: 25, summary: "Up to 25 active agents, live ledger, signed checkpoints, coverage analyses." },
  business: { id: "business", name: "Business", priceUsdMonthly: 1199, activeCertificates: 100, summary: "Up to 100 active agents, everything in Team, priority support." },
};

// Dodo statuses that keep the paid plan's limits. on_hold is a failed renewal Dodo is still retrying:
// the customer keeps access while it resolves, as with the other RootSystems products.
const PAID_STATUSES = new Set(["active", "on_hold"]);

export interface BillingOptions {
  apiKey: string | null;
  environment: "live_mode" | "test_mode";
  webhookKey: string | null;
  productIds: { team: string | null; business: string | null };
  // Where Dodo returns the customer after checkout.
  returnUrl: string;
}

export class ConsoleBilling {
  private client: DodoPayments | null = null;

  constructor(
    private readonly store: Store,
    private readonly options: BillingOptions,
  ) {}

  configured(): boolean {
    return Boolean(this.options.apiKey && this.options.productIds.team && this.options.productIds.business);
  }

  private dodo(): DodoPayments {
    if (!this.configured()) throw new AppError(503, "BILLING_NOT_CONFIGURED", "Billing is not configured on this server.");
    if (!this.client) {
      this.client = new DodoPayments({
        bearerToken: this.options.apiKey!,
        webhookKey: this.options.webhookKey,
        environment: this.options.environment,
      });
    }
    return this.client;
  }

  private planForProduct(productId: string | undefined): PlanId | null {
    if (productId && productId === this.options.productIds.team) return "team";
    if (productId && productId === this.options.productIds.business) return "business";
    return null;
  }

  async current(organizationId: string): Promise<{ plan: Plan; subscription: ConsoleSubscription | null }> {
    const subscription = await this.store.getConsoleSubscription(organizationId);
    const paid = subscription && PAID_STATUSES.has(subscription.status) ? PLANS[subscription.plan as PlanId] : undefined;
    return { plan: paid ?? PLANS.free, subscription };
  }

  async checkout(organization: Organization, email: string, planId: "team" | "business"): Promise<string> {
    const productId = this.options.productIds[planId];
    const existing = await this.store.getConsoleSubscription(organization.id);
    let session;
    try {
      session = await this.dodo().checkoutSessions.create({
        product_cart: [{ product_id: productId!, quantity: 1 }],
        customer: existing?.dodoCustomerId ? { customer_id: existing.dodoCustomerId } : { email },
        metadata: { organizationId: organization.id, product: "agent-governance" },
        return_url: this.options.returnUrl,
      });
    } catch {
      throw new AppError(502, "CHECKOUT_UNAVAILABLE", "Checkout could not be started. Please try again in a moment.");
    }
    if (!session.checkout_url) throw new AppError(502, "CHECKOUT_UNAVAILABLE", "Checkout could not be started.");
    return session.checkout_url;
  }

  // Verifies the signature (Standard Webhooks, via the SDK), ignores redeliveries, and records the
  // subscription's plan and status for the workspace named in its metadata.
  async handleWebhook(rawBody: string, headers: Record<string, string>): Promise<{ handled: boolean; reason?: string }> {
    let event: { type: string; data: Record<string, unknown> & { payload_type?: string } };
    try {
      event = this.dodo().webhooks.unwrap(rawBody, { headers }) as unknown as typeof event;
    } catch {
      throw new AppError(400, "INVALID_WEBHOOK", "Webhook signature did not verify.");
    }
    const eventId = headers["webhook-id"];
    if (eventId && !(await this.store.claimBillingWebhookEvent(eventId, event.type))) {
      return { handled: true, reason: "duplicate delivery" };
    }
    if (event.data.payload_type !== "Subscription") return { handled: false, reason: `ignored ${event.type}` };

    const data = event.data as {
      subscription_id?: string;
      product_id?: string;
      status?: string;
      next_billing_date?: string | null;
      metadata?: Record<string, string>;
      customer?: { customer_id?: string };
    };
    const organizationId = data.metadata?.organizationId;
    if (!organizationId || !(await this.store.getOrganization(organizationId))) {
      return { handled: false, reason: "no matching workspace" };
    }
    const plan = this.planForProduct(data.product_id);
    if (!plan) return { handled: false, reason: "not an Agent Governance product" };

    // Webhooks can arrive out of order: never let an older event overwrite a newer one.
    const timestamp = headers["webhook-timestamp"] ? new Date(Number(headers["webhook-timestamp"]) * 1000).toISOString() : new Date().toISOString();
    const existing = await this.store.getConsoleSubscription(organizationId);
    if (existing?.lastEventAt && Date.parse(existing.lastEventAt) > Date.parse(timestamp)) {
      return { handled: true, reason: "older than the stored state" };
    }
    await this.store.saveConsoleSubscription({
      organizationId,
      plan,
      status: data.status ?? "pending",
      dodoCustomerId: data.customer?.customer_id ?? existing?.dodoCustomerId ?? null,
      dodoSubscriptionId: data.subscription_id ?? existing?.dodoSubscriptionId ?? null,
      renewsAt: data.next_billing_date ?? null,
      lastEventAt: timestamp,
    });
    return { handled: true };
  }
}
