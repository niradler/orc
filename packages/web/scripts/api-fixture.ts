import { createServer } from "node:net";

export async function reserveLoopbackPort(port = 0): Promise<{
  port: number;
  release: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const assigned = (server.address() as { port: number }).port;
  let released: Promise<void> | undefined;
  return {
    port: assigned,
    release: () => {
      released ??= new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      return released;
    },
  };
}

export async function withRunningApis<T>(
  apis: { exited: Promise<number> }[],
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      operation(controller.signal),
      ...apis.map((api, index) =>
        api.exited.then((code): never => {
          throw new Error(`Browser shard ${index + 1} API exited unexpectedly with code ${code}`);
        }),
      ),
    ]);
  } finally {
    controller.abort();
  }
}
