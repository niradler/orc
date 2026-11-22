import type { BuddyTransport } from "../bridge.js";
import { LineDecoder } from "../protocol.js";

export type SerialPortInfo = {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
};

/** Native bindings load only when a real port is opened; simulate needs none. */
async function loadSerialPort() {
  try {
    return await import("serialport");
  } catch {
    throw new Error(
      "Serial support needs the serialport package. Use the npm/bun install of ORC, or run --simulate; standalone binaries ship without native serial bindings.",
    );
  }
}

export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  const { SerialPort } = await loadSerialPort();
  return SerialPort.list();
}

export async function openSerialTransport(
  path: string,
  baudRate = 115200,
): Promise<BuddyTransport> {
  const { SerialPort } = await loadSerialPort();
  const port = new SerialPort({ path, baudRate, autoOpen: false });
  await new Promise<void>((resolve, reject) => {
    port.open((error) => (error ? reject(error) : resolve()));
  });

  const decoder = new LineDecoder();
  const messageHandlers: ((value: unknown) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  let closed = false;

  port.on("data", (chunk: Buffer) => {
    for (const value of decoder.push(chunk.toString("utf8"))) {
      for (const handler of messageHandlers) handler(value);
    }
  });
  port.on("close", () => {
    if (closed) return;
    closed = true;
    for (const handler of closeHandlers) handler();
  });
  port.on("error", () => {
    // A disconnected USB adapter surfaces as close; nothing else to do here.
  });

  return {
    label: `serial ${path} @ ${baudRate}`,
    send(line) {
      if (closed) return;
      port.write(line);
    },
    onMessage(handler) {
      messageHandlers.push(handler);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      if (closed) return;
      closed = true;
      return new Promise<void>((resolve) => port.close(() => resolve()));
    },
  };
}
