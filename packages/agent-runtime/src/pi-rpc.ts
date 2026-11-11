import type {
  RpcCommand,
  RpcExtensionUIResponse,
  RpcResponse,
} from "@earendil-works/pi-coding-agent";
import { type ExecHost, type HostProcess, hostSpawn } from "@orc/core/exec-host";
import { providerProcessEnvironment } from "@orc/core/provider-service";
import { z } from "zod";
import { endStdin, readLines, STREAM_DRAIN_TIMEOUT_MS } from "./io.js";

const responseSchema = z.object({
  type: z.literal("response"),
  id: z.string().optional(),
  command: z.string(),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
}) satisfies z.ZodType<Pick<RpcResponse, "type" | "command" | "success">>;
export class PiRpc {
  private child: HostProcess;
  private readonly pending = new Map<
    string,
    {
      command: string;
      resolve: (value: z.infer<typeof responseSchema>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout> | undefined;
      timeoutMs: number;
    }
  >();
  private sequence = 0;
  private humanWaiting = false;
  private failure?: Error;
  private closing = false;
  private readonly readerAbort = new AbortController();
  private readonly listeners = new Set<(record: unknown) => void>();
  private readonly failures = new Set<(error: Error) => void>();
  private writing: Promise<void> = Promise.resolve();
  private reading: Promise<void> = Promise.resolve();

  private constructor(child: HostProcess) {
    this.child = child;
  }

  static async start(
    host: ExecHost,
    command: string[],
    cwd: string,
    env: Record<string, string> = {},
  ): Promise<PiRpc> {
    const child = await hostSpawn(host, command, {
      cwd,
      env: providerProcessEnvironment(env),
      passEnv: Object.keys(env),
      stdin: "pipe",
      stderr: "ignore",
    });
    const client = new PiRpc(child);
    if (!child.proc.stdout || typeof child.proc.stdout === "number") {
      child.kill();
      throw new Error("Pi RPC stdout is unavailable.");
    }
    client.reading = readLines(
      child.proc.stdout,
      (line) => client.receive(line),
      client.readerAbort.signal,
      16 * 1024 * 1024,
    )
      .then(() => {
        if (!client.closing)
          client.fail(new Error("Pi RPC process exited or closed its protocol stream."));
      })
      .catch(() => client.fail(new Error("Pi RPC protocol stream failed.")));
    void child.proc.exited.then(async (code) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.reading,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, STREAM_DRAIN_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        client.readerAbort.abort();
      }
      if (!client.closing) client.fail(new Error(`Pi RPC process exited (${code}).`));
    });
    return client;
  }

  onRecord(listener: (record: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onFailure(listener: (error: Error) => void): () => void {
    this.failures.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.failures.delete(listener);
  }
  private receive(line: string): void {
    try {
      const record: unknown = JSON.parse(line);
      if (
        !record ||
        typeof record !== "object" ||
        !("type" in record) ||
        typeof record.type !== "string"
      )
        throw new Error("invalid record");
      if (record.type === "response") {
        const response = responseSchema.parse(record);
        const pending = response.id ? this.pending.get(response.id) : undefined;
        if (!pending || !response.id) return;
        if (response.command !== pending.command) throw new Error("response command mismatch");
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.success) pending.resolve(response);
        else pending.reject(new Error(response.error ?? "Pi RPC command failed."));
      } else {
        for (const listener of this.listeners) listener(record);
      }
    } catch {
      this.fail(new Error("Pi RPC protocol returned an invalid record."));
    }
  }
  private fail(error: Error): void {
    if (this.failure || this.closing) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    for (const listener of this.failures) listener(error);
    this.child.kill();
  }
  async write(record: RpcCommand | RpcExtensionUIResponse): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.closing) throw new Error("Pi RPC is closed.");
    const text = `${JSON.stringify(record)}\n`;
    const write = this.writing.then(async () => {
      const stdin = this.child.proc.stdin;
      if (!stdin || typeof stdin === "number") throw new Error("Pi RPC stdin is unavailable.");
      stdin.write(text);
      await stdin.flush();
    });
    this.writing = write.catch(() => {});
    try {
      await write;
    } catch {
      this.fail(new Error("Pi RPC input stream failed."));
      throw this.failure;
    }
  }
  request(command: RpcCommand, timeoutMs = 30_000): Promise<z.infer<typeof responseSchema>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new Error("Pi RPC is closed."));
    const id = `orc-${++this.sequence}`;
    return new Promise((resolve, reject) => {
      const timer =
        this.humanWaiting && ["prompt", "compact"].includes(command.type)
          ? undefined
          : setTimeout(() => {
              this.fail(new Error(`Pi RPC ${command.type} timed out.`));
            }, timeoutMs);
      this.pending.set(id, { command: command.type, resolve, reject, timer, timeoutMs });
      void this.write({ ...command, id }).catch((error) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }
  waitingForHuman(waiting: boolean): void {
    this.humanWaiting = waiting;
    for (const request of this.pending.values()) {
      if (!["prompt", "compact"].includes(request.command)) continue;
      clearTimeout(request.timer);
      request.timer = waiting
        ? undefined
        : setTimeout(
            () => this.fail(new Error(`Pi RPC ${request.command} timed out.`)),
            request.timeoutMs,
          );
    }
  }
  alive(): boolean {
    return !this.closing && !this.failure && this.child.proc.exitCode === null;
  }
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("Pi RPC is closed."));
    }
    this.pending.clear();
    endStdin(this.child.proc.stdin);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.child.proc.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
      if (this.child.proc.exitCode === null) {
        this.child.kill();
        await Promise.race([
          this.child.proc.exited,
          new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              this.child.proc.kill("SIGKILL");
              resolve();
            }, 2000);
          }),
        ]);
      }
    } finally {
      clearTimeout(timer);
      this.readerAbort.abort();
      await this.reading;
      this.listeners.clear();
      this.failures.clear();
    }
  }
}
