export type SkillRepository = {
  repository: string;
  ref: string;
  path: string;
  skill?: string | undefined;
};
export type RemoteSkill = { name: string; description: string; path: string; installed: boolean };
export type SkillDiscovery = SkillRepository & {
  commit: string;
  skills: RemoteSkill[];
  issues: Array<{ path: string; error: string }>;
};
export type SkillImportInput = { source: string; commit: string; paths: string[] };
export type SkillImportOrigin = SkillRepository & { commit: string; importedAt: string };
export type SkillSyncResult = {
  applied: boolean;
  commit: string;
  changed: string[];
  conflicts: string[];
  revision: string;
};
export type SkillSyncInput = {
  override?: boolean | undefined;
  expectedCommit?: string | undefined;
  expectedRevision?: string | undefined;
};
