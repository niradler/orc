import { shortId } from "@orc/core/ids";
import { createOrcClient } from "@orc/sdk";

let _client: ReturnType<typeof createOrcClient> | null = null;

function client() {
  if (!_client) _client = createOrcClient();
  return _client;
}

export async function apiListActiveTasks(projectId?: string | null) {
  const res = await client().tasks.list({
    limit: 20,
    ...(projectId ? { project_id: projectId } : {}),
  });
  if (res.error) throw new Error(res.error.error);
  return (res.data?.tasks ?? []).filter(
    (t) => !["done", "cancelled"].includes(t.status),
  );
}

export async function apiFindTask(input: string) {
  if (input.length === 26) {
    const res = await client().tasks.get(input);
    return res.error ? null : res.data;
  }
  const res = await client().tasks.list({ limit: 100 });
  if (res.error) return null;
  return (res.data?.tasks ?? []).find((t) => t.id.endsWith(input)) ?? null;
}

export async function apiApproveTask(taskId: string, note?: string) {
  const c = client();
  await c.tasks.update(taskId, { status: "done" });
  if (note) await c.tasks.addComment(taskId, note, "human");
}

export async function apiRejectTask(taskId: string, note?: string) {
  const c = client();
  await c.tasks.update(taskId, { status: "changes_requested" });
  if (note) await c.tasks.addComment(taskId, note, "human");
}

export async function apiCreateTask(title: string, projectId?: string | null) {
  const res = await client().tasks.create({
    title,
    ...(projectId ? { project_id: projectId } : {}),
  });
  if (res.error) throw new Error(res.error.error);
  return res.data!;
}

export async function apiSearchMemories(query: string, projectId?: string | null) {
  const res = await client().memories.search(query, {
    limit: 5,
    ...(projectId ? { project_id: projectId } : {}),
  });
  if (res.error) throw new Error(res.error.error);
  return res.data?.results ?? [];
}

export async function apiListJobs(projectId?: string | null) {
  const res = await client().jobs.list({
    limit: 20,
    enabled: true,
    ...(projectId ? { project_id: projectId } : {}),
  });
  if (res.error) throw new Error(res.error.error);
  return res.data?.jobs ?? [];
}

export async function apiFindJobByName(name: string) {
  const res = await client().jobs.list({ limit: 200 });
  if (res.error) return null;
  return (res.data?.jobs ?? []).find((j) => j.name === name) ?? null;
}

export async function apiTriggerJob(jobId: string) {
  const res = await client().jobs.trigger(jobId);
  if (res.error) throw new Error(res.error.error);
  return res.data!.run_id;
}

export async function apiListProjects() {
  const res = await client().projects.list({ status: "active", limit: 50 });
  if (res.error) throw new Error(res.error.error);
  return res.data?.projects ?? [];
}

export async function apiFindProjectByName(name: string) {
  const res = await client().projects.getByName(name);
  return res.error ? null : res.data;
}

export async function apiFindProjectById(id: string) {
  const res = await client().projects.get(id);
  return res.error ? null : res.data;
}

export { shortId };
