import type { FastifyPluginAsync } from "fastify";

// Dodo Payments webhook for the Agent Governance console. Unauthenticated by design: the Standard
// Webhooks signature (checked in ConsoleBilling.handleWebhook) is the authentication, and it covers
// the exact raw bytes, so this plugin keeps the body as a string instead of parsing JSON.
export const billingWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => done(null, body));

  app.post("/webhook", async (request, reply) => {
    const headers: Record<string, string> = {};
    for (const name of ["webhook-id", "webhook-signature", "webhook-timestamp"]) {
      const value = request.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    const result = await app.billing.handleWebhook(typeof request.body === "string" ? request.body : "", headers);
    return reply.send({ received: true, handled: result.handled });
  });
};
