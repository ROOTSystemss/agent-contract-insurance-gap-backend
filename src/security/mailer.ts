// Transactional email (account verification and password reset). Delivery goes through Resend when
// RESEND_API_KEY is set. Links in these messages are capabilities, so neither the message body nor the
// link is ever logged.

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type MailResult = { sent: true } | { sent: false; reason: "no-provider-configured" | "reserved-domain" | "delivery-failed" };

export interface Mailer {
  send(message: MailMessage): Promise<MailResult>;
}

// Special-use and documentation domains (RFC 2606, RFC 6761): mail to them can never be delivered, so it
// is never handed to the provider at all. Test and smoke accounts use them.
const RESERVED_TLDS = new Set(["test", "example", "invalid", "localhost"]);
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];
export function isReservedEmailDomain(email: string): boolean {
  const domain = String(email).split("@").pop()?.trim().toLowerCase().replace(/\.$/, "") ?? "";
  if (!domain) return true;
  const tld = domain.split(".").pop() ?? "";
  return RESERVED_TLDS.has(tld) || RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

export function createResendMailer(options: { apiKey: string; from: string; replyTo: string; fetchImpl?: typeof fetch; log?: (message: string) => void }): Mailer {
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? ((message: string) => console.warn(message));
  return {
    async send(message) {
      if (isReservedEmailDomain(message.to)) return { sent: false, reason: "reserved-domain" };
      try {
        const response = await fetchImpl("https://api.resend.com/emails", {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${options.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ from: options.from, reply_to: options.replyTo, to: message.to, subject: message.subject, html: message.html, text: message.text }),
        });
        if (!response.ok) {
          log(`[mailer] transactional message was not delivered (provider answered ${response.status})`);
          return { sent: false, reason: "delivery-failed" };
        }
        return { sent: true };
      } catch {
        log("[mailer] transactional message was not delivered (provider unreachable)");
        return { sent: false, reason: "delivery-failed" };
      }
    },
  };
}

export const noMailer: Mailer = {
  async send() {
    return { sent: false, reason: "no-provider-configured" };
  },
};

// Tests: keeps every message in memory instead of sending it. Reserved domains are still refused, like the
// real mailer, unless acceptReserved is set (tests use example.test addresses and need the links).
export class OutboxMailer implements Mailer {
  readonly messages: MailMessage[] = [];
  constructor(private readonly acceptReserved = true) {}
  async send(message: MailMessage): Promise<MailResult> {
    if (!this.acceptReserved && isReservedEmailDomain(message.to)) return { sent: false, reason: "reserved-domain" };
    this.messages.push(message);
    return { sent: true };
  }
  last(to?: string): MailMessage | undefined {
    const list = to ? this.messages.filter((m) => m.to === to) : this.messages;
    return list[list.length - 1];
  }
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(title: string, paragraphs: string[], button: { label: string; url: string }, footer: string): string {
  return (
    '<div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;max-width:480px;margin:0 auto;padding:32px 24px;">' +
    '<div style="height:4px;background:linear-gradient(90deg,#0A1F44 0%,#FF9933 50%,#1E9E45 100%);margin-bottom:24px;border-radius:2px;"></div>' +
    `<h1 style="color:#0A1F44;font-size:20px;margin:0 0 16px;">${escapeHtml(title)}</h1>` +
    paragraphs.map((p) => `<p style="color:#52525b;font-size:14px;line-height:1.6;">${escapeHtml(p)}</p>`).join("") +
    `<p style="margin:28px 0;"><a href="${escapeHtml(button.url)}" style="background:#FF9933;color:#0A1F44;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;display:inline-block;">${escapeHtml(button.label)}</a></p>` +
    `<p style="color:#8a8a92;font-size:12.5px;line-height:1.6;">${escapeHtml(footer)}</p></div>`
  );
}

export function verificationMessage(product: string, to: string, url: string, hours: number): MailMessage {
  const lead = `Open the link below to confirm this address for your ${product} account. Until then the account can sign in and look around, but cannot issue certificates, sign approvals or build signed Assurance Packs. The link expires in ${hours} hours.`;
  const footer = "If you did not create this account, ignore this email: nobody can use the address without this link.";
  return {
    to,
    subject: `Confirm your email for ${product}`,
    html: layout("Confirm your email", [lead], { label: "Confirm email", url }, footer),
    text: `Confirm your email for ${product}:\n${url}\n\n${lead}\n\n${footer}`,
  };
}

export function resetMessage(product: string, to: string, url: string, minutes: number): MailMessage {
  const lead = `We received a request to reset the password for your ${product} account. Open the link below to choose a new one. It expires in ${minutes} minutes and works once.`;
  const footer = "If you did not request this, ignore this email: your password will not change unless the link is opened.";
  return {
    to,
    subject: `Reset your ${product} password`,
    html: layout("Reset your password", [lead], { label: "Reset password", url }, footer),
    text: `Reset your ${product} password:\n${url}\n\n${lead}\n\n${footer}`,
  };
}
