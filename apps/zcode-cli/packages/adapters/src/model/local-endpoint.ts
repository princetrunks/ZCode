/**
 * Sando: does a provider base URL point at a self-hosted model? Loopback, RFC 1918 / CGNAT / link-local IPv4,
 * IPv6 loopback / ULA / link-local, `localhost`, and `*.local` / `*.lan` / `*.internal` hostnames count.
 * Used by the `lean-local` prompt profile; a public hostname that merely resolves to a LAN address does not.
 */
export function isLocalEndpoint(baseURL: string | undefined): boolean {
  if (!baseURL) return false;
  let hostname: string;
  try {
    hostname = new URL(baseURL).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith("[") && hostname.endsWith("]")) hostname = hostname.slice(1, -1);
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (/\.(local|lan|internal|home\.arpa)$/.test(hostname)) return true;

  const v4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      hostname === "0.0.0.0"
    );
  }
  if (hostname.includes(":")) {
    if (hostname === "::1" || hostname === "::") return true;
    const mapped = hostname.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isLocalEndpoint(`http://${mapped[1]}`);
    return /^f[cd][0-9a-f]{0,2}:/.test(hostname) || /^fe[89ab][0-9a-f]?:/.test(hostname);
  }
  return false;
}
