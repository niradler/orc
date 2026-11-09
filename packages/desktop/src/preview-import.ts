import { randomUUID } from "node:crypto";
import type { PreviewImportResult, PreviewImportSource } from "@orc/core/desktop-preview";
import { previewWebUrl } from "@orc/core/desktop-preview";
import type { Session } from "electron";
import { z } from "zod";

/** This connection never leaves the trusted main process and is never available to agents. */
class ImportConnection {
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string" || event.data.length > 8_000_000) {
        this.close();
        return;
      }
      let message: { id?: number; result?: unknown; error?: unknown };
      try {
        message = JSON.parse(event.data);
      } catch {
        this.close();
        return;
      }
      if (!message.id) return;
      const call = this.pending.get(message.id);
      if (!call) return;
      clearTimeout(call.timer);
      this.pending.delete(message.id);
      if (message.error) call.reject(new Error("The source browser rejected the import request"));
      else call.resolve(message.result);
    });
    socket.addEventListener("close", () => this.close());
    socket.addEventListener("error", () => this.close());
  }
  static async open(
    endpoint: string,
    onCreate: (connection: ImportConnection) => void,
  ): Promise<ImportConnection> {
    const socket = new WebSocket(endpoint);
    const connection = new ImportConnection(socket);
    onCreate(connection);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.close();
        reject(
          new Error(
            "Source browser connection timed out. Approve its connection prompt, then retry.",
          ),
        );
      }, 15000);
      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(new Error("Source browser is unavailable or access was denied"));
        },
        { once: true },
      );
      socket.addEventListener(
        "close",
        () => {
          clearTimeout(timer);
          reject(new Error("Source browser connection was closed"));
        },
        { once: true },
      );
    });
    return connection;
  }
  async call(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("Source browser disconnected");
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Source browser import request timed out"));
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(
          JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
        );
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Source browser disconnected"));
      }
    });
  }
  close(): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("Source browser disconnected"));
    }
    this.pending.clear();
    if (
      this.socket.readyState === WebSocket.OPEN ||
      this.socket.readyState === WebSocket.CONNECTING
    )
      this.socket.close();
  }
}

const targetsSchema = z.object({
  targetInfos: z
    .array(z.object({ targetId: z.string(), type: z.string(), url: z.string() }))
    .max(1000),
});
const cookieSchema = z.object({
  name: z.string().max(4096),
  value: z.string().max(65536),
  domain: z.string().max(255),
  path: z.string().max(4096),
  secure: z.boolean(),
  httpOnly: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  expires: z.number().optional(),
  session: z.boolean().optional(),
  partitionKey: z.unknown().optional(),
});

/** User-selected live-browser transfer avoids bypassing Chromium's app-bound encryption. */
export class PreviewImport {
  private source: {
    id: string;
    endpoint: string;
    expires: number;
    sites: string[];
    product: string;
    userAgent: string;
    targets: { targetId: string; site: string }[];
  } | null = null;
  private connection: ImportConnection | null = null;
  private generation = 0;
  constructor(private readonly orcOrigin: string) {}
  cancel(): void {
    this.generation++;
    this.source = null;
    this.connection?.close();
    this.connection = null;
  }
  async discover(port: number): Promise<PreviewImportSource> {
    this.cancel();
    const generation = this.generation;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
      redirect: "error",
      signal: AbortSignal.timeout(3000),
    });
    const version = z
      .object({ webSocketDebuggerUrl: z.string().max(1000) })
      .parse(await response.json());
    const endpoint = new URL(version.webSocketDebuggerUrl);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.port !== String(port) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash ||
      !/^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint.pathname)
    )
      throw new Error("Import requires a local browser debugging endpoint");
    const connection = await ImportConnection.open(endpoint.href, (connection) => {
      this.connection = connection;
    });
    if (generation !== this.generation) {
      connection.close();
      throw new Error("Browser import cancelled");
    }
    this.connection = connection;
    try {
      const browser = z
        .object({ product: z.string(), userAgent: z.string() })
        .parse(await connection.call("Browser.getVersion"));
      if (/Electron|ORC/i.test(browser.userAgent) || !/Chrome|Chromium|Edg/i.test(browser.product))
        throw new Error("Select a Chrome/Edge browser profile, not ORC or another Electron app");
      const { targetInfos } = targetsSchema.parse(await connection.call("Target.getTargets"));
      if (
        targetInfos.some((target) => {
          try {
            return new URL(target.url).origin === this.orcOrigin;
          } catch {
            return false;
          }
        })
      )
        throw new Error("Close ORC pages in the source browser before importing logins");
      const sites = [
        ...new Set(
          targetInfos
            .filter((target) => target.type === "page" && previewWebUrl(target.url))
            .map((target) => new URL(target.url).origin),
        ),
      ].slice(0, 100);
      const id = randomUUID();
      this.source = {
        id,
        endpoint: endpoint.href,
        expires: Date.now() + 120000,
        sites,
        product: browser.product,
        userAgent: browser.userAgent,
        targets: targetInfos
          .filter((target) => target.type === "page" && previewWebUrl(target.url))
          .map((target) => ({ targetId: target.targetId, site: new URL(target.url).origin })),
      };
      return { id, name: browser.product.slice(0, 80), sites };
    } finally {
      connection.close();
      if (this.connection === connection) this.connection = null;
    }
  }
  async transfer(
    sourceId: string,
    sites: string[],
    target: { cookies: Pick<Session["cookies"], "set" | "flushStore"> },
  ): Promise<PreviewImportResult> {
    const source = this.source;
    this.source = null;
    if (
      !source ||
      source.id !== sourceId ||
      source.expires < Date.now() ||
      !sites.length ||
      sites.some((site) => !source.sites.includes(site))
    )
      throw new Error("Import selection expired or changed. Discover the source again.");
    const generation = this.generation;
    const connection = await ImportConnection.open(source.endpoint, (connection) => {
      this.connection = connection;
    });
    if (generation !== this.generation) {
      connection.close();
      throw new Error("Browser import cancelled");
    }
    this.connection = connection;
    let imported = 0,
      skipped = 0;
    try {
      const browser = z
        .object({ product: z.string(), userAgent: z.string() })
        .parse(await connection.call("Browser.getVersion"));
      if (
        browser.product !== source.product ||
        browser.userAgent !== source.userAgent ||
        /Electron|ORC/i.test(browser.userAgent)
      )
        throw new Error("Source browser identity changed");
      const { targetInfos } = targetsSchema.parse(await connection.call("Target.getTargets"));
      if (
        targetInfos.some(
          (target) => previewWebUrl(target.url) && new URL(target.url).origin === this.orcOrigin,
        )
      )
        throw new Error("Source browser now contains ORC pages");
      for (const site of sites) {
        if (generation !== this.generation) throw new Error("Browser import cancelled");
        const page = targetInfos.find(
          (target) =>
            target.type === "page" &&
            previewWebUrl(target.url) &&
            new URL(target.url).origin === site &&
            source.targets.some(
              (original) => original.targetId === target.targetId && original.site === site,
            ),
        );
        if (!page) throw new Error("A selected source tab was closed. Discover the source again.");
        const { sessionId } = z.object({ sessionId: z.string() }).parse(
          await connection.call("Target.attachToTarget", {
            targetId: page.targetId,
            flatten: true,
          }),
        );
        try {
          const result = z
            .object({ cookies: z.array(cookieSchema).max(10000) })
            .parse(
              await connection.call(
                "Network.getCookies",
                { urls: [`${site}/`, `${site}${new URL(page.url).pathname}`] },
                sessionId,
              ),
            );
          const hostname = new URL(site).hostname;
          for (const cookie of result.cookies) {
            if (generation !== this.generation) throw new Error("Browser import cancelled");
            const domain = cookie.domain.replace(/^\./, "");
            if (
              cookie.name.toLowerCase() === "orc_session" ||
              cookie.partitionKey ||
              (hostname !== domain && !hostname.endsWith(`.${domain}`)) ||
              (cookie.expires && cookie.expires > 0 && cookie.expires <= Date.now() / 1000)
            ) {
              skipped++;
              continue;
            }
            try {
              await target.cookies.set({
                url: site + cookie.path,
                name: cookie.name,
                value: cookie.value,
                ...(cookie.domain.startsWith(".") ? { domain: cookie.domain } : {}),
                path: cookie.path,
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
                sameSite:
                  cookie.sameSite === "Strict"
                    ? "strict"
                    : cookie.sameSite === "Lax"
                      ? "lax"
                      : cookie.sameSite === "None"
                        ? "no_restriction"
                        : "unspecified",
                ...(cookie.expires && cookie.expires > 0 ? { expirationDate: cookie.expires } : {}),
              });
              imported++;
            } catch {
              skipped++;
            }
          }
        } finally {
          await connection.call("Target.detachFromTarget", { sessionId });
        }
      }
      await target.cookies.flushStore();
      return { imported, skipped };
    } catch {
      throw new Error(
        `Import did not complete (${imported} cookies written, ${skipped} skipped). Verify the source connection and retry; some sites may require signing in again.`,
      );
    } finally {
      connection.close();
      if (this.connection === connection) this.connection = null;
    }
  }
}
