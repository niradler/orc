import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "./release-lib.js";
import {
  assertReleaseVersion,
  type ReleaseCommand,
  type ReleaseState,
} from "./release-verification.js";

const START = "<!-- ORC-RELEASE-VERIFICATION:START -->";
const END = "<!-- ORC-RELEASE-VERIFICATION:END -->";

export function verifiedReleaseNotes(body: string, version: string, digest: string): string {
  assertReleaseVersion(version);
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Missing verified Docker digest");
  const summary = `${START}\n## Verified release\n\n- npm: \`orc-ai@${version}\` (latest), archive checksum verified.\n- Docker: \`niradler/orc:${version}\` and \`latest\`, Linux amd64 and arm64; startup, authentication and dashboard checked.\n- Docker manifest: \`${digest}\`.\n- Attached binary/installer digests and checksums verified; local desktop and daemon version verified.\n${END}`;
  const start = body.indexOf(START);
  const end = body.indexOf(END);
  if (start === -1 && end === -1) return `${body.trimEnd()}\n\n${summary}\n`;
  if (
    start === -1 ||
    end < start ||
    body.indexOf(START, start + START.length) !== -1 ||
    body.indexOf(END, end + END.length) !== -1
  )
    throw new Error(
      "Release notes have malformed verification markers; refusing to overwrite them",
    );
  return `${body.slice(0, start)}${summary}${body.slice(end + END.length)}`;
}

export function publishReleaseNotes(
  root: string,
  state: ReleaseState,
  command: ReleaseCommand = run,
): void {
  if (!state.docker_digest) throw new Error("Missing verified release digest");
  const route = `repos/niradler/orc/releases/tags/v${state.version}`;
  const current = JSON.parse(
    command("gh", ["api", route], { capture: true, timeout: 30_000, quiet: true }),
  ) as { body?: string };
  const updated = verifiedReleaseNotes(current.body ?? "", state.version, state.docker_digest);
  if (updated !== current.body) {
    const folder = join(root, ".orc", `release-${state.version}`);
    mkdirSync(folder, { recursive: true });
    const file = join(folder, "verified-release-notes.md");
    writeFileSync(file, updated);
    command("gh", ["release", "edit", `v${state.version}`, "--notes-file", file], {
      timeout: 30_000,
      quiet: true,
    });
  }
  const saved = JSON.parse(
    command("gh", ["api", route], { capture: true, timeout: 30_000, quiet: true }),
  ) as { body?: string };
  if (saved.body !== updated)
    throw new Error("Published verification notes did not match the saved release summary");
}
