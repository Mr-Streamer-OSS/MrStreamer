// The process an adapter starts in place of the AirPlay helper, for fake-airplay-helper.ts. It
// has no behaviour of its own: it passes the adapter's lines on its stdin to the test over a
// local socket, and writes what the test sends back to its stdout. Like the helper it exits when
// its stdin closes, unless the test told it to stay, and it never outlives the test's socket.
import { connect } from "node:net";
import { createInterface } from "node:readline";

const socket = connect(Number(process.argv[2]), "127.0.0.1");
let stays = false;
socket.on("error", () => process.exit(1));
socket.on("close", () => process.exit(1));
socket.write(`${process.pid}\n`);

// From the test: "=<line>" to write as it is, "!exit <code>", or "!stay".
createInterface({ input: socket }).on("line", (line) => {
  if (line === "!stay") stays = true;
  else if (line.startsWith("!exit ")) process.exit(Number(line.slice(6)));
  else process.stdout.write(`${line.slice(1)}\n`);
});

createInterface({ input: process.stdin })
  .on("line", (line) => socket.write(`${line}\n`))
  .on("close", () => {
    if (!stays) process.exit(0);
  });
