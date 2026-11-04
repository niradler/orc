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

/** A skill source: a coding agent's skills folder, or (id "folder") any folder scanned recursively. */
export type LocalSkillAgent = { id: string; label: string; dir: string; recursive?: boolean };
/** The closest other skill by content: same text, a tiny edit (near) or largely the same (similar). */
export type SkillMatch = {
  name: string;
  level: "identical" | "near" | "similar";
  score: number;
  /** "orc" for an ORC skill, otherwise the folder the match was found in. */
  where: string;
};
/**
 * new: not in ORC · installed: ORC has the same name and content · duplicate: ORC already has the
 * same skill apart from a tiny edit, under this or another name · conflict: ORC has the same name
 * with other content · changed: the source changed since it was imported and the ORC copy is
 * untouched · invalid: cannot be imported. `match` names the closest ORC skill when it is at least
 * similar, so near copies are flagged before they are kept twice.
 */
export type LocalSkillStatus =
  | "new"
  | "installed"
  | "duplicate"
  | "conflict"
  | "changed"
  | "invalid";
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
  match?: SkillMatch | undefined;
  error?: string | undefined;
};
export type LocalSkillAgentListing = LocalSkillAgent & { skills: LocalSkill[] };
/** `path` picks one skill when a folder source has several with the same name. */
export type LocalSkillImportItem = { agent: string; name: string; path?: string | undefined };
export type LocalSkillImportResult = {
  imported: Array<{ name: string; description: string; path: string }>;
  skipped: Array<LocalSkillImportItem & { reason: string }>;
};

/** Where ORC skills are exported: a coding agent's skills folder or any absolute folder. */
export type SkillExportTarget = { agent: string } | { path: string };
/**
 * new: not in the target · identical: the target has the same files · near: the target has the
 * same skill apart from a tiny edit · conflict: the target has this name with other content ·
 * duplicate: the target has the same skill under another name · blocked: cannot be written.
 */
export type SkillExportStatus = "new" | "identical" | "near" | "conflict" | "duplicate" | "blocked";
export type SkillExportPlanItem = {
  name: string;
  description: string;
  status: SkillExportStatus;
  /** Folder the skill is written to: <target>/<name>. */
  path: string;
  /** Whether `overwrite` may replace the existing target folder. */
  can_overwrite: boolean;
  match?: SkillMatch | undefined;
  reason?: string | undefined;
};
export type SkillExportPlan = { dir: string; label: string; skills: SkillExportPlanItem[] };
export type SkillExportResult = {
  dir: string;
  exported: Array<{ name: string; path: string; replaced: boolean; backup?: string | undefined }>;
  skipped: Array<{ name: string; reason: string }>;
};
