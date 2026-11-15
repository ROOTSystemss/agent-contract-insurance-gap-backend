import { isIP } from "node:net";

// Which hops of X-Forwarded-For to believe. Hop 0 is the connection itself, hop 1 the right-most header
// entry, and so on; the client address is the first hop that is not trusted. On Render the chain is
// client -> Cloudflare edge -> Render proxy -> app (measured live 2026-11-14), so hops = 3.
//
// Hop 0 is trusted only when it is a private address: the app is reached through Render's internal
// network. A direct connection from a public address is never treated as a proxy, so whatever it puts
// in X-Forwarded-For is ignored. (A bare hop count cannot check this, which is why Fastify refuses one.)
export function trustProxyHops(hops: number): (address: string, hop: number) => boolean {
  return (address, hop) => hop < hops && (hop > 0 || isPrivateAddress(address));
}

export function isPrivateAddress(raw: string): boolean {
  const address = String(raw || "").trim().replace(/^::ffff:/i, "");
  if (isIP(address) === 4) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || /^f[cd][0-9a-f]{2}:/.test(lower) || /^fe[89ab][0-9a-f]:/.test(lower);
  }
  return false;
}
