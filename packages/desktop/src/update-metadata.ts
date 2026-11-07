const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,180}$/;
const SHA512 = /^[A-Za-z0-9+/]{20,}={0,2}$/;

export type UpdateFile = {
  url: string;
  sha512: string;
  blockMapSize?: number;
};

export type UpdateInfo = {
  version: string;
  files: UpdateFile[];
};

export function updateInfoFileName(targetId: string, version?: string): string {
  const channel = version?.match(/^\d+\.\d+\.\d+-([0-9A-Za-z-]+)/)?.[1] ?? "latest";
  switch (targetId) {
    case "windows-x64":
      return `${channel}.yml`;
    case "mac-arm64":
      return `${channel}-mac.yml`;
    case "linux-x64":
      return `${channel}-linux.yml`;
    case "linux-arm64":
      return `${channel}-linux-arm64.yml`;
    default:
      throw new Error(`Unsupported desktop target: ${targetId}`);
  }
}

export function parseUpdateInfo(text: string): UpdateInfo {
  const value: unknown = Bun.YAML.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Update metadata is empty");
  const record = value as Record<string, unknown>;
  if (typeof record.version !== "string" || !VERSION.test(record.version))
    throw new Error("Update metadata version is invalid");
  if (!Array.isArray(record.files) || record.files.length === 0)
    throw new Error("Update metadata has no files");
  const files = record.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("Update metadata file is invalid");
    const file = entry as Record<string, unknown>;
    if (typeof file.url !== "string" || !FILE_NAME.test(file.url))
      throw new Error("Update metadata file name is invalid");
    if (typeof file.sha512 !== "string" || !SHA512.test(file.sha512))
      throw new Error(`Update metadata hash is invalid for ${file.url}`);
    const parsed: UpdateFile = { url: file.url, sha512: file.sha512 };
    if (file.blockMapSize != null) {
      if (!Number.isInteger(file.blockMapSize) || Number(file.blockMapSize) < 1)
        throw new Error(`Update metadata blockmap is invalid for ${file.url}`);
      parsed.blockMapSize = Number(file.blockMapSize);
    }
    return parsed;
  });
  return { version: record.version, files };
}

export function assertUpdatePayload(targetId: string, info: UpdateInfo): void {
  const matches =
    targetId === "mac-arm64"
      ? info.files.some((file) => file.url.endsWith(".zip"))
      : targetId === "windows-x64"
        ? info.files.some((file) => file.url.endsWith(".exe"))
        : targetId.startsWith("linux-")
          ? info.files.some((file) => file.url.endsWith(".AppImage"))
          : true;
  if (!matches) throw new Error(`Update metadata for ${targetId} does not reference its installer`);
}
