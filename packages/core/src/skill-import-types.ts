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

export type LocalSkillAgent = { id: string; label: string; dir: string };
/**
 * new: not in ORC · installed: ORC has the same name and content · conflict: ORC has the same
 * name with other content · changed: the source changed since it was imported and the ORC copy
 * is untouched · invalid: cannot be imported. The name lives in SKILL.md, so equal content always
 * means an equal name; the same skill in several agents is reported through `also_in`.
 */
export type LocalSkillStatus = "new" | "installed" | "conflict" | "changed" | "invalid";
export type LocalSkill = {
  agent: string;
  name: string;
  description: string;
  path: string;
  content_hash: string;
  status: LocalSkillStatus;
  /** Other agents exposing the same content (often symlinks to one folder). */
  also_in: string[];
  /** Top-level frontmatter fields outside the skill spec (e.g. model); kept in metadata. */
  extra_fields: string[];
  error?: string | undefined;
};
export type LocalSkillAgentListing = LocalSkillAgent & { skills: LocalSkill[] };
export type LocalSkillImportItem = { agent: string; name: string };
export type LocalSkillImportResult = {
  imported: Array<{ name: string; description: string; path: string }>;
  skipped: Array<LocalSkillImportItem & { reason: string }>;
};
