import { loadConfig } from "@orc/core/config";
import { getDb, getSqlite } from "@orc/db/client";
import { KnowledgeService } from "./service.js";

let instance: Promise<KnowledgeService> | null = null;

/**
 * The process-wide service over orc.db and the configured knowledge root. Opening it starts job
 * processing; the daemon additionally calls `startKnowledgeMaintenance()`.
 */
export function getKnowledgeService(): Promise<KnowledgeService> {
  if (!instance) {
    instance = KnowledgeService.open({
      db: getSqlite(getDb()),
      config: () => loadConfig().knowledge,
    }).then((svc) => {
      svc.start({ maintenance: false });
      return svc;
    });
    instance.catch(() => {
      instance = null;
    });
  }
  return instance;
}

/** Daemon only: periodic registered-folder rescans, usage retention and job cleanup. */
export async function startKnowledgeMaintenance(): Promise<void> {
  const svc = await getKnowledgeService();
  svc.start({ maintenance: true });
}

export async function closeKnowledgeService(): Promise<void> {
  if (!instance) return;
  const pending = instance;
  instance = null;
  const svc = await pending.catch(() => null);
  if (!svc) return;
  await svc.stop();
  svc.close();
}
