import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import { createInterface } from "node:readline";
import { expect, it } from "vitest";
import { startFakeAirplayHelper } from "./fake-airplay-helper.ts";

it("rejects unrelated socket traffic without replacing the owned relay", async () => {
  const helper = await startFakeAirplayHelper();
  const relay = spawn(helper.helper, [...helper.args], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(relay, "exit");
  const lines = createInterface({ input: relay.stdout });
  const output = lines[Symbol.asyncIterator]();

  try {
    expect((await output.next()).value).toBe('{"type":"hello","protocol":1}');
    expect((await output.next()).value).toBe('{"type":"volume","level":1,"muted":false}');

    for (const traffic of [
      "GET / HTTP/1.1\r\nhost: localhost\r\n\r\n",
      `${process.pid}\nnot JSON\n`,
      Buffer.from([0, 255, 10, 1, 254, 10]),
    ]) {
      const socket = connect(Number(helper.args[1]), "127.0.0.1");

      try {
        const closed = once(socket, "close");
        await once(socket, "connect");
        socket.end(traffic);
        await closed;
      } finally {
        socket.destroy();
      }
    }

    relay.stdin.write('{"id":1,"cmd":"detect","on":true}\n');
    expect((await output.next()).value).toBe('{"type":"answer","id":1,"ok":true}');
    expect((await output.next()).value).toBe('{"type":"routes","available":false}');

    // Deliberate bad helper output and a crash must still reach the owned process.
    helper.write("not JSON");
    expect((await output.next()).value).toBe("not JSON");
    helper.crash();
    expect(await exited).toEqual([1, null]);
  } finally {
    lines.close();
    relay.kill();
    await exited;
    await helper.close();
  }
});
