import { expect, test } from "bun:test";
import { PiRpc } from "../pi-rpc";

const host = { kind: "local" } as const;
const run = (source: string) => [process.execPath, "-e", source];

test("Pi RPC correlates concurrent responses and preserves Unicode separators", async () => {
  const client = await PiRpc.start(
    host,
    run(
      `for await (const l of console) {const c=JSON.parse(l); const out=JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{text:'a\\u2028b',value:c.type}})+'\\n'; process.stdout.write(out.slice(0,8)); process.stdout.write(out.slice(8));}`,
    ),
    process.cwd(),
  );
  try {
    const [a, b] = await Promise.all([
      client.request({ type: "get_state" }),
      client.request({ type: "get_messages" }),
    ]);
    expect(a.data).toEqual({ text: "a\u2028b", value: "get_state" });
    expect(b.data).toEqual({ text: "a\u2028b", value: "get_messages" });
  } finally {
    await client.close();
  }
});

test("Pi RPC rejects failed commands and outstanding requests on exit", async () => {
  const client = await PiRpc.start(
    host,
    run(
      `for await (const l of console) {const c=JSON.parse(l);if(c.type==='get_messages')process.exit(7);console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:false,error:'rejected'}));}`,
    ),
    process.cwd(),
  );
  try {
    await expect(client.request({ type: "get_state" })).rejects.toThrow("rejected");
    await expect(client.request({ type: "get_messages" })).rejects.toThrow("exited");
  } finally {
    await client.close();
  }
});

test("Pi RPC fails closed on malformed records and bounds a missing reply", async () => {
  const malformed = await PiRpc.start(
    host,
    run(`for await (const l of console) console.log('not json');`),
    process.cwd(),
  );
  try {
    await expect(malformed.request({ type: "get_state" })).rejects.toThrow("protocol");
  } finally {
    await malformed.close();
  }
  const quiet = await PiRpc.start(host, run(`for await (const l of console) {}`), process.cwd());
  try {
    await expect(quiet.request({ type: "get_state" }, 50)).rejects.toThrow("timed out");
  } finally {
    await quiet.close();
  }
});

test("Pi RPC suspends acceptance deadlines while a human dialog is open", async () => {
  const client = await PiRpc.start(
    host,
    run(
      `for await(const l of console){const c=JSON.parse(l);setTimeout(()=>console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{disposition:'handled'}})),120);}`,
    ),
    process.cwd(),
  );
  try {
    client.waitingForHuman(true);
    const response = client.request({ type: "prompt", message: "Ask a question" }, 50);
    await Bun.sleep(160);
    expect((await response).success).toBe(true);
    client.waitingForHuman(false);
  } finally {
    await client.close();
  }
});

test("Pi RPC bounds stream drain when an exited process leaves inherited stdout open", async () => {
  let pid: number | undefined;
  let failed = false;
  const client = await PiRpc.start(
    host,
    run(
      `for await(const l of console){const c=JSON.parse(l);const child=Bun.spawn([${JSON.stringify(process.execPath)},'-e','setTimeout(()=>{},6000)'],{stdout:'inherit',stderr:'ignore',stdin:'ignore'});console.log(JSON.stringify({type:'descendant',pid:child.pid}));console.log(JSON.stringify({type:'response',id:c.id,command:c.type,success:true,data:{}}));process.exit(0);}`,
    ),
    process.cwd(),
  );
  client.onRecord((record) => {
    if (record && typeof record === "object" && "pid" in record && typeof record.pid === "number")
      pid = record.pid;
  });
  client.onFailure(() => {
    failed = true;
  });
  try {
    await client.request({ type: "get_state" });
    await Bun.sleep(2300);
    expect(failed).toBe(true);
  } finally {
    if (pid)
      try {
        process.kill(pid);
      } catch {}
    await client.close();
  }
}, 10000);
