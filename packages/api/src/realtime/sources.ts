import { existsSync, statSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { getUserAgentsDir } from "@orc/core/agent-service";
import { type ChangeResource, changes } from "@orc/core/changes";
import { resetConfig } from "@orc/core/config";
import { type ExecHost, hostExec } from "@orc/core/exec-host";
import { getProjectFlowsDir, getUserFlowsDir, reloadFlows } from "@orc/core/flow-service";
import { createLogger } from "@orc/core/logger";
import { getPackagesDir } from "@orc/core/package-service";
import { getBuiltinSkillsDir, getUserSkillsDir, reloadCache } from "@orc/core/skill-service";
import { getDb } from "@orc/db/client";
import { watchRemotePaths } from "./host-watch.js";

const logger = createLogger("api:realtime");
const checkouts = new Map<string, { host: ExecHost; cwd: string }>();
const active = new Map<string, () => void>();
let clients = 0;
let generation = 0;

export function watchResourcePath(
  path: string,
  onChange: () => void,
  recursive = true,
): () => void {
  const target = resolve(path);
  let watcher: ReturnType<typeof watch> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const recover = (): void => {
    watcher?.close();
    clearTimeout(retry);
    if (closed) return;
    retry = setTimeout(() => {
      attach();
    }, 1000);
    retry.unref();
  };
  const attach = (): void => {
    watcher?.close();
    if (closed) return;
    let root = target;
    while (!existsSync(root) && dirname(root) !== root) root = dirname(root);
    const exact = root === target;
    const directory = statSync(root, { throwIfNoEntry: false })?.isDirectory() ?? false;
    if (!directory) root = dirname(root);
    try {
      watcher = watch(
        root,
        { recursive: exact && directory && recursive, persistent: false },
        (_event, name) => {
          const changed = name ? resolve(root, String(name)) : root;
          const inside = relative(target, changed);
          const parent = relative(changed, target);
          if (inside.startsWith("..") && parent.startsWith("..")) return;
          const parts = inside.replace(/\\/g, "/").split("/");
          if (parts.some((part) => ["node_modules", ".cache", "dist", ".next"].includes(part)))
            return;
          if (
            parts.includes(".git") &&
            (parts.includes("objects") || parts.includes("logs") || parts.at(-1)?.endsWith(".lock"))
          )
            return;
          if (timer) return;
          timer = setTimeout(() => {
            timer = undefined;
            if (closed) return;
            onChange();
            if (!exact || !existsSync(target)) attach();
          }, 100);
          timer.unref();
        },
      );
      watcher.on("error", (error) => {
        logger.error("Resource watcher failed", error);
        recover();
      });
      if (retry) {
        retry = undefined;
        onChange();
      }
    } catch (error) {
      logger.error("Cannot watch resource", error);
      recover();
    }
  };
  attach();
  return () => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(retry);
    watcher?.close();
  };
}

function startCheckout(key: string, checkout: { host: ExecHost; cwd: string }): void {
  if (active.has(key)) return;
  const notify = (): void => changes.publish("git", "files");
  active.set(
    key,
    checkout.host.kind === "ssh"
      ? watchRemotePaths(checkout.host, [checkout.cwd], notify)
      : watchResourcePath(checkout.cwd, notify),
  );
}

export function observeCheckout(host: ExecHost, cwd: string): void {
  const key = `checkout:${host.kind === "ssh" ? host.alias : "local"}:${cwd}`;
  if (!checkouts.has(key)) {
    if (checkouts.size >= 128) {
      logger.warn("Checkout watcher capacity reached; reconnect to renew subscriptions");
      return;
    }
    checkouts.set(key, { host, cwd });
    const currentGeneration = generation;
    void hostExec(
      host,
      [
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
      ],
      { cwd, timeoutMs: 5000 },
    )
      .then((result) => {
        if (generation !== currentGeneration) return;
        if (result.code !== 0) return;
        for (const path of result.stdout.trim().split(/\r?\n/)) {
          if (!path) continue;
          const relatedKey = `checkout:${host.kind === "ssh" ? host.alias : "local"}:${path}`;
          if (checkouts.has(relatedKey)) continue;
          checkouts.set(relatedKey, { host, cwd: path });
          if (clients) startCheckout(relatedKey, { host, cwd: path });
        }
      })
      .catch((error) => logger.error("Cannot watch repository metadata", error));
  }
  if (clients) startCheckout(key, { host, cwd });
}

export function retainChangeSources(): () => void {
  getDb();
  if (clients++ === 0) {
    const register = (path: string, resources: ChangeResource[], refresh?: () => unknown): void => {
      const key = `resource:${path}`;
      if (active.has(key)) return;
      active.set(
        key,
        watchResourcePath(path, () => {
          try {
            refresh?.();
          } catch (error) {
            logger.error("Resource refresh failed", error);
          }
          changes.publish(...resources);
        }),
      );
    };
    for (const path of [
      getUserSkillsDir(),
      getBuiltinSkillsDir(),
      join(process.cwd(), ".orc", "skills"),
      join(process.cwd(), ".apm", "skills"),
    ])
      register(path, ["skills"], reloadCache);
    for (const path of [
      getUserAgentsDir(),
      join(process.cwd(), "agents"),
      join(process.cwd(), ".orc", "agents"),
      join(process.cwd(), ".apm", "agents"),
    ])
      register(path, ["agents"]);
    for (const path of [getUserFlowsDir(), getProjectFlowsDir()])
      register(path, ["flows"], reloadFlows);
    register(getPackagesDir(), ["packages", "agents", "skills"], reloadCache);
    register(
      join(homedir(), ".orc", "config.json"),
      ["settings", "ssh", "terminals", "backends", "health"],
      resetConfig,
    );
    register(
      join(process.cwd(), ".orc", "config.json"),
      ["settings", "ssh", "terminals", "backends", "health"],
      resetConfig,
    );
    register(join(homedir(), ".ssh", "config"), ["ssh"]);
    for (const [key, checkout] of checkouts) startCheckout(key, checkout);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--clients === 0) {
      for (const stop of active.values()) stop();
      active.clear();
      checkouts.clear();
      generation++;
    }
  };
}
