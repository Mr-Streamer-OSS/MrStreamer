/** Recognizes callable capabilities across realms without executing the candidate. */
function isCallable(value) {
  try {
    Function.prototype.toString.call(value);

    return true;
  } catch {
    return false;
  }
}

// Socket paths, host names and fetch URLs use primitive strings, not boxed values.
function isAddress(value) {
  try {
    return value === String.prototype.valueOf.call(value);
  } catch {
    return false;
  }
}

// A UDP overload's positive numeric port. Intrinsic extraction never invokes a callback argument.
function isPort(value) {
  try {
    return value === Number.prototype.valueOf.call(value) && value > 0;
  } catch {
    return false;
  }
}

// Loaded into the verified app's main process with NODE_OPTIONS=--require, for the downloads
// scenarios only. It records every outbound TCP connection and UDP send main makes, so the proof
// can say what main asked of the network and when, and it answers artwork hosts from the run's
// loopback picture server: fixtures replace the external image CDN as they replace TMDB's API.
// It changes nothing else. Chromium's own requests are recorded over CDP by the scenario.
const dgram = require("node:dgram");
const fs = require("node:fs");
const net = require("node:net");

const log = process.env.VERIFY_NETWORK_LOG;
const images = process.env.VERIFY_IMAGES;
const IMAGE_HOSTS = new Set(["image.tmdb.org", "image.example"]);

function write(entry) {
  if (log) fs.appendFileSync(log, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
}

const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];

  if (first && first === Object(first) && !isCallable(first)) {
    if (first.path) write({ kind: "ipc", path: String(first.path) });
    else write({ kind: "tcp", host: first.host ?? "localhost", port: Number(first.port) });
  } else if (isAddress(first) && Number.isNaN(Number(first))) {
    write({ kind: "ipc", path: first });
  } else {
    write({
      kind: "tcp",
      host: isAddress(args[1]) ? args[1] : "localhost",
      port: Number(first),
    });
  }

  return connect.apply(this, args);
};

const send = dgram.Socket.prototype.send;

dgram.Socket.prototype.send = function (...args) {
  const address = args.find((arg, index) => index > 0 && isAddress(arg));

  const port = args.find((arg, index) => index > 0 && isPort(arg));

  write({ kind: "udp", host: address ?? "unknown", port: port ?? null });

  return send.apply(this, args);
};

// Main puts undici's fetch in place as it starts (src/main/fetch.ts), after this runs, so the
// hook stays in front of whichever fetch is installed.
let fetchInstalled = globalThis.fetch;

const fetchHooked = (input, init) => {
  const href = isAddress(input) ? input : input instanceof URL ? input.href : input.url;

  const url = URL.parse(href);

  if (images && url && IMAGE_HOSTS.has(url.hostname)) {
    write({ kind: "artwork", host: url.hostname, path: url.pathname });

    return fetchInstalled(`${images}${url.pathname}`, init);
  }

  return fetchInstalled(input, init);
};

Object.defineProperty(globalThis, "fetch", {
  configurable: true,
  enumerable: true,
  get: () => fetchHooked,
  set: (fetch) => {
    fetchInstalled = fetch;
  },
});
