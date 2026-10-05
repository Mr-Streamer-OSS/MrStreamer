// Which of this computer's addresses a receiver on the local network can reach. A receiver plays
// from an address the proxy serves on that network, so the address has to be on the network the
// receiver is on: the interface that reaches it, not a VPN's or the one the default route takes.
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

/** Interfaces that are tunnels, by the names systems give them: VPNs, containers, virtual machines. */
const TUNNEL =
  /^(utun|tun|tap|ppp|ipsec|wg|tailscale|zt|docker|br-|veth|virbr|vmnet|vboxnet|llw|awdl|anpi|bridge)/i;

/** Whether `address` is IPv4 in a range only local networks use, or this computer itself. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const parts = (mapped?.[1] ?? address).split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return address === "::1";
  }
  const [a = 0, b = 0] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * This computer's addresses a receiver may reach it at, likeliest first: private IPv4 addresses
 * of interfaces that aren't tunnels, wired and wireless ones before the rest, addresses a network
 * handed out before the ones a computer gives itself. Carrier-grade ranges, as VPNs such as
 * Tailscale use, are left out. `interfaces` is the system's list.
 */
export function lanAddresses(
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces(),
): string[] {
  const found: { readonly address: string; readonly rank: number }[] = [];
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (TUNNEL.test(name)) continue;
    for (const each of addresses ?? []) {
      if (each.family !== "IPv4" || each.internal || !isPrivateAddress(each.address)) continue;
      const selfGiven = each.address.startsWith("169.254.");
      const physical = /^(en|eth|wl|wi-?fi|ethernet)/i.test(name);
      found.push({ address: each.address, rank: (selfGiven ? 2 : 0) + (physical ? 0 : 1) });
    }
  }
  return found.toSorted((a, b) => a.rank - b.rank).map((each) => each.address);
}
