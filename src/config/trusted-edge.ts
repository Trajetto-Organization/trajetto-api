import { BlockList, isIP } from "node:net";

/**
 * Cloudflare's edge, as Cloudflare publishes it.
 *
 * Production is Cloudflare -> Traefik -> API, and CF-Connecting-IP is the only
 * place the real client address survives that chain. Cloudflare overwrites the
 * header, but only on requests that went THROUGH Cloudflare: whoever reaches
 * the origin on its own IP writes the header themselves. The origin firewall
 * now admits only these ranges on 80 and 443 (docs/deploy.md, section 6.1),
 * and this check stays as the second lock: the one thing such a caller cannot
 * choose is the address Traefik saw them connect from, so the header is
 * believed only when that address is one of these.
 *
 * The IPv4 half below is also that firewall's allowlist, and
 * .github/workflows/cloudflare-ranges.yml compares the whole list with
 * Cloudflare's every Monday.
 *
 * Which also means a Cloudflare Tunnel is NOT a drop-in origin lock: behind
 * one, Traefik's peer is the cloudflared connector, never one of these ranges,
 * and every client would share its bucket (docs/deploy.md (Domínios, TLS e a borda)).
 *
 * Copied from https://www.cloudflare.com/ips-v4 and /ips-v6 on 2026-09-24.
 * Cloudflare announces changes well ahead; a range missing here only makes
 * the users served from it share their edge's bucket (as `xff` did for
 * everyone), it never lets a forged header through. To re-check:
 *   curl -s https://www.cloudflare.com/ips-v4; curl -s https://www.cloudflare.com/ips-v6
 */
const CLOUDFLARE_EDGE_CIDRS: readonly string[] = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

function edgeMatcher(cidrs: readonly string[]): (address: string) => boolean {
  const list = new BlockList();

  for (const cidr of cidrs) {
    const [network, prefix] = cidr.split("/");
    const family = isIP(network);

    if (family === 0 || prefix === undefined) {
      throw new Error(`CIDR inválido na lista da borda: ${cidr}`);
    }

    list.addSubnet(network, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }

  return (address) => {
    // An IPv4 peer on a dual-stack socket reads as ::ffff:a.b.c.d.
    const plain = address
      .trim()
      .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
    const family = isIP(plain);

    if (family === 0) return false;

    return list.check(plain, family === 4 ? "ipv4" : "ipv6");
  };
}

const isCloudflareEdge = edgeMatcher(CLOUDFLARE_EDGE_CIDRS);

export { CLOUDFLARE_EDGE_CIDRS, isCloudflareEdge };
