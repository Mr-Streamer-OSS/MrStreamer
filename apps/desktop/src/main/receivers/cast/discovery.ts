// Finds the Cast receivers on the local network by multicast DNS: each answers a browse for
// `_googlecast._tcp.local` with its name, id, address and port.
//
// It asks in one-shot queries from a port of its own, with the bit that asks for the answer by
// unicast, on each of this computer's addresses on a local network (see ../../playback/lan.ts). Nothing binds port 5353, which the
// system's own responder may hold, and Windows needs no Bonjour. In return it hears only the
// answers to its own questions, not receivers announcing themselves or leaving, so it asks again
// on a short backoff and drops a receiver that stopped answering.
//
// Everything it reads comes from whoever is on the network, so it reads little: four record
// types, within limits on sizes and counts, and a packet that breaks one is ignored whole.
import { createSocket, type Socket } from "node:dgram";
import type { Receiver } from "@mrstreamer/contracts/output";
import { isPrivateAddress, lanAddresses } from "../../playback/lan.ts";

/** A receiver and where its Cast channel listens. */
export interface CastEndpoint {
  readonly receiver: Receiver;
  readonly host: string;
  readonly port: number;
}

/** What the adapter asks of a way to find receivers. Tests supply their own. */
export interface CastDiscovery {
  /** Hears the whole list each time it changes, and when a scan starts. One listener. */
  listen(listener: (receivers: readonly Receiver[]) => void): void;
  /** Looks for receivers while `on`. What it found stays known after it stops. */
  scan(on: boolean): void;
  /** Where a receiver it found is, or null when it knows none by that id. */
  locate(id: string): CastEndpoint | null;
}

export interface DiscoveryOptions {
  /** Where the questions go: the mDNS group, unless a test answers elsewhere. */
  readonly group?: { readonly address: string; readonly port: number };
  /** This computer's addresses to ask from: those on its local networks, unless given. */
  readonly addresses?: () => readonly string[];
  /** Milliseconds between questions, the last one repeating. */
  readonly backoff?: readonly number[];
  /** Milliseconds a receiver stays listed without answering. */
  readonly expiry?: number;
}

const GROUP = { address: "224.0.0.251", port: 5353 };
const BACKOFF = [1000, 2000, 4000, 8000];
const EXPIRY = 30_000;

const SERVICE = ["_googlecast", "_tcp", "local"];
const TYPE = { a: 1, ptr: 12, txt: 16, srv: 33 } as const;
/** The class of every record here, and the bit on a question that asks for a unicast answer. */
const INTERNET = 1;
const UNICAST = 0x8000;

/** The largest message mDNS allows. */
const MAX_PACKET = 9000;
/** Questions, and records, a packet may hold. One receiver answers with about six. */
const MAX_RECORDS = 100;
/** Bytes a name may take, as DNS limits it, and how many pointers it may follow. */
const MAX_NAME = 255;
const MAX_HOPS = 8;
/** Services and hosts remembered, the oldest going first. */
const KEPT = 64;
/** Questions a query adds for records a receiver left out of its answer. */
const FOLLOW_UPS = 8;

/**
 * TXT `ca`, a receiver's capabilities as bits. The two read here: bit 0, it shows video, and
 * bit 5, it is a group of speakers rather than a device.
 */
const VIDEO_OUT = 1 << 0;
const SPEAKER_GROUP = 1 << 5;

/** A name's labels, as their bytes in Latin-1, so any byte survives being sent back. */
type Name = readonly string[];

type DnsRecord =
  | { readonly type: "ptr"; readonly name: Name; readonly target: Name }
  | { readonly type: "srv"; readonly name: Name; readonly target: Name; readonly port: number }
  | { readonly type: "txt"; readonly name: Name; readonly entries: ReadonlyMap<string, string> }
  | { readonly type: "a"; readonly name: Name; readonly address: string };

/** One advertised service: `<name>._googlecast._tcp.local`. */
interface Service {
  readonly name: Name;
  srv: { readonly host: Name; readonly port: number } | null;
  txt: ReadonlyMap<string, string> | null;
  /** When it last answered, on the `performance.now()` clock. */
  seen: number;
}

/** A name as a key: DNS names compare without regard to ASCII case. */
const key = (name: Name) => name.join(".").replace(/[A-Z]/g, (letter) => letter.toLowerCase());
const SERVICE_KEY = key(SERVICE);

/**
 * The name at `start` and where the record goes on after it; null for what isn't a name. A
 * compression pointer must lead to before the part it was found in, so following them always
 * ends, and a name follows a few at most.
 */
function readName(packet: Buffer, start: number): { labels: string[]; next: number } | null {
  const labels: string[] = [];
  let offset = start;
  let floor = start;
  let next = -1;
  let size = 1;
  for (let hops = 0; ;) {
    const length = packet[offset];
    if (length === undefined) return null;
    if (length === 0) return { labels, next: next < 0 ? offset + 1 : next };
    if (length >= 0xc0) {
      const low = packet[offset + 1];
      if (low === undefined) return null;
      const target = ((length & 0x3f) << 8) | low;
      if (target >= floor || ++hops > MAX_HOPS) return null;
      if (next < 0) next = offset + 2;
      offset = floor = target;
      continue;
    }
    // 64 to 191 are label kinds DNS never came to use.
    size += length + 1;
    if (length > 63 || size > MAX_NAME || offset + 1 + length > packet.length) return null;
    labels.push(packet.toString("latin1", offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
}

/** A TXT record's `key=value` strings, the first of each key, with keys in lower case. */
function readText(data: Buffer): Map<string, string> | null {
  const entries = new Map<string, string>();
  for (let offset = 0; offset < data.length;) {
    const end = offset + 1 + data[offset]!;
    if (end > data.length) return null;
    const entry = data.subarray(offset + 1, end);
    const equals = entry.indexOf(0x3d);
    const name = entry.toString("latin1", 0, Math.max(0, equals)).toLowerCase();
    if (name && !entries.has(name)) entries.set(name, entry.subarray(equals + 1).toString("utf8"));
    offset = end;
  }
  return entries;
}

/**
 * The records of an mDNS answer that the browse reads: PTR, SRV, TXT and A. Null for a packet
 * that isn't an answer, is over a limit or doesn't parse: none of it is used then.
 */
function readAnswer(packet: Buffer): DnsRecord[] | null {
  if (packet.length < 12 || packet.length > MAX_PACKET) return null;
  // The flags' top bit tells an answer from a question.
  if ((packet.readUInt16BE(2) & 0x8000) === 0) return null;
  const questions = packet.readUInt16BE(4);
  const count = packet.readUInt16BE(6) + packet.readUInt16BE(8) + packet.readUInt16BE(10);
  if (questions > MAX_RECORDS || count > MAX_RECORDS) return null;

  let offset = 12;
  for (let index = 0; index < questions; index++) {
    const name = readName(packet, offset);
    if (!name) return null;
    offset = name.next + 4;
  }
  const records: DnsRecord[] = [];
  for (let index = 0; index < count; index++) {
    const name = readName(packet, offset);
    if (!name || name.next + 10 > packet.length) return null;
    const type = packet.readUInt16BE(name.next);
    // The top bit of the class says to replace what was known, which the browse does anyway.
    const internet = (packet.readUInt16BE(name.next + 2) & 0x7fff) === INTERNET;
    const start = name.next + 10;
    const end = start + packet.readUInt16BE(name.next + 8);
    if (end > packet.length) return null;
    offset = end;
    if (!internet) continue;

    if (type === TYPE.a) {
      if (end - start !== 4) return null;
      records.push({
        type: "a",
        name: name.labels,
        address: packet.subarray(start, end).join("."),
      });
    } else if (type === TYPE.txt) {
      const entries = readText(packet.subarray(start, end));
      if (!entries) return null;
      records.push({ type: "txt", name: name.labels, entries });
    } else if (type === TYPE.ptr || type === TYPE.srv) {
      // A service's record holds its priority, weight and port ahead of the host's name.
      const at = type === TYPE.srv ? start + 6 : start;
      const target = at <= end ? readName(packet, at) : null;
      if (!target || target.next !== end) return null;
      records.push(
        type === TYPE.ptr
          ? { type: "ptr", name: name.labels, target: target.labels }
          : {
              type: "srv",
              name: name.labels,
              target: target.labels,
              port: packet.readUInt16BE(start + 4),
            },
      );
    }
  }
  return records;
}

/** A question for `name`'s records of `type`, to be answered by unicast. */
function question(name: Name, type: number): Buffer {
  const tail = Buffer.alloc(5);
  tail.writeUInt16BE(type, 1);
  tail.writeUInt16BE(INTERNET | UNICAST, 3);
  return Buffer.concat([
    ...name.map((label) => Buffer.from([label.length, ...Buffer.from(label, "latin1")])),
    tail,
  ]);
}

/**
 * Whether a device with these capabilities shows video. Speakers and groups of them are left
 * out; a device that doesn't say is listed, as one that might.
 */
function showsVideo(capabilities: string | undefined): boolean {
  if (!capabilities || !/^\d{1,9}$/.test(capabilities)) return true;
  const bits = Number(capabilities);
  return (bits & VIDEO_OUT) !== 0 && (bits & SPEAKER_GROUP) === 0;
}

/** Sets `name` in a map that keeps its newest `KEPT` entries. */
function keep<V>(map: Map<string, V>, name: string, value: V): void {
  map.delete(name);
  map.set(name, value);
  for (const oldest of map.keys()) {
    if (map.size <= KEPT) break;
    map.delete(oldest);
  }
}

/** The mDNS browse for Cast receivers. It opens nothing until a scan starts. */
export function castDiscovery(options: DiscoveryOptions = {}): CastDiscovery {
  const group = options.group ?? GROUP;
  const backoff = options.backoff ?? BACKOFF;
  const expiry = options.expiry ?? EXPIRY;
  const services = new Map<string, Service>();
  /** Hosts' addresses, by name. */
  const hosts = new Map<string, string>();
  /** One socket for each of this computer's addresses, while scanning. */
  const sockets = new Map<string, Socket>();
  let listener: (receivers: readonly Receiver[]) => void = () => {};
  let scanning = false;
  let timer: NodeJS.Timeout | undefined;
  let round = 0;
  /** The list as last told, to tell a change by. */
  let told = "";

  /** The receivers that answered in full, one for each id, without speakers and groups. */
  const list = (): CastEndpoint[] => {
    const found = new Map<string, CastEndpoint>();
    for (const service of services.values()) {
      const id = service.txt?.get("id");
      const host = service.srv && hosts.get(key(service.srv.host));
      if (!id || !host || !service.srv || found.has(id)) continue;
      if (!showsVideo(service.txt?.get("ca"))) continue;
      found.set(id, {
        receiver: { id, kind: "cast", name: service.txt?.get("fn") || null },
        host,
        port: service.srv.port,
      });
    }
    return [...found.values()];
  };

  const tell = (always = false) => {
    const endpoints = list();
    const now = JSON.stringify(endpoints);
    if (now === told && !always) return;
    told = now;
    listener(endpoints.map((endpoint) => endpoint.receiver));
  };

  /** The service a record of `name` belongs to, heard from just now; null for another's. */
  const heard = (name: Name): Service | null => {
    if (name.length !== SERVICE.length + 1 || key(name.slice(1)) !== SERVICE_KEY) return null;
    // A known one keeps its place, so the list keeps its order from one answer to the next.
    const known = services.get(key(name));
    const service = known ?? { name, srv: null, txt: null, seen: 0 };
    service.seen = performance.now();
    if (!known) keep(services, key(name), service);
    return service;
  };

  const take = (records: readonly DnsRecord[], from: string) => {
    for (const record of records) {
      if (record.type === "a") {
        // An answer can name any address, and the app would connect there. One that isn't the
        // sender's own must at least be a local network's. A device with several addresses
        // answers from the one on this network, so that one is preferred.
        const name = key(record.name);
        if (record.address === from) keep(hosts, name, record.address);
        else if (!hosts.has(name) && isPrivateAddress(record.address)) {
          keep(hosts, name, record.address);
        }
      } else if (record.type === "ptr") {
        if (key(record.name) === SERVICE_KEY) heard(record.target);
      } else {
        const service = heard(record.name);
        if (service && record.type === "srv") {
          service.srv = { host: record.target, port: record.port };
        } else if (service && record.type === "txt") {
          service.txt = record.entries;
        }
      }
    }
  };

  /**
   * The browse, and questions for what a receiver named in an earlier answer left out of it:
   * its service and text records, or its host's address.
   */
  const query = (): Buffer => {
    const questions = [question(SERVICE, TYPE.ptr)];
    for (const service of services.values()) {
      if (questions.length > FOLLOW_UPS) break;
      if (!service.srv) questions.push(question(service.name, TYPE.srv));
      else if (!hosts.has(key(service.srv.host))) {
        questions.push(question(service.srv.host, TYPE.a));
      }
      if (!service.txt) questions.push(question(service.name, TYPE.txt));
    }
    const header = Buffer.alloc(12);
    header.writeUInt16BE(questions.length, 4);
    return Buffer.concat([header, ...questions]);
  };

  const shut = (address: string, socket: Socket) => {
    if (sockets.get(address) === socket) sockets.delete(address);
    try {
      socket.close();
    } catch {
      // Closed already.
    }
  };

  /** A socket on `address`, which asks as soon as it is bound. */
  const open = (address: string) => {
    const socket = createSocket("udp4");
    sockets.set(address, socket);
    socket.on("error", () => shut(address, socket));
    socket.on("message", (packet, from) => {
      const records = readAnswer(packet);
      if (!records) return;
      take(records, from.address);
      tell();
    });
    socket.bind(0, address, () => {
      try {
        socket.setMulticastTTL(255);
        socket.setMulticastInterface(address);
        socket.send(query(), group.port, group.address, () => {});
      } catch {
        shut(address, socket);
      }
    });
  };

  /**
   * Asks on every address this computer has now, forgets who stopped answering, and tells the
   * list when it changed, or whatever it is on the `first` round of a scan.
   */
  const ask = (first = false) => {
    const addresses = new Set(options.addresses?.() ?? lanAddresses());
    for (const [address, socket] of sockets) {
      if (!addresses.has(address)) shut(address, socket);
    }
    const packet = query();
    for (const address of addresses) {
      const socket = sockets.get(address);
      if (socket) socket.send(packet, group.port, group.address, () => {});
      else open(address);
    }
    for (const [name, service] of services) {
      if (performance.now() - service.seen > expiry) services.delete(name);
    }
    tell(first);
    timer = setTimeout(() => ask(), backoff[Math.min(round++, backoff.length - 1)]);
  };

  return {
    listen(next) {
      listener = next;
    },
    scan(on) {
      if (on === scanning) return;
      scanning = on;
      if (on) {
        round = 0;
        ask(true);
        return;
      }
      clearTimeout(timer);
      for (const [address, socket] of sockets) shut(address, socket);
    },
    locate: (id) => list().find((endpoint) => endpoint.receiver.id === id) ?? null,
  };
}
