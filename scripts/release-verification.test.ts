import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishDockerRelease } from "./release-docker.js";
import { publishReleaseNotes, verifiedReleaseNotes } from "./release-notes.js";
import {
  npmArtifact,
  publishedDockerImages,
  publishNpmArtifact,
  RELEASE_STAGES,
  type ReleaseCommand,
  type ReleaseFetch,
  type ReleaseState,
  releaseIsComplete,
  verifyDockerPublication,
  verifyGitHubPublication,
  verifyNpmPublication,
  waitForNpmPublication,
} from "./release-verification.js";

const folder = mkdtempSync(join(tmpdir(), "orc-release-verification-"));
const bytes = Buffer.from("prepared release archive");
const revision = "a".repeat(40);
const digest = `sha256:${"b".repeat(64)}`;
let sequence = 0;

function prepared(): ReturnType<typeof npmArtifact> {
  const file = join(folder, `release-${sequence++}.tgz`);
  writeFileSync(file, bytes);
  return npmArtifact(file);
}

function metadata(artifact: ReturnType<typeof npmArtifact>): Response {
  return Response.json({
    version: "1.2.3",
    dist: { shasum: artifact.shasum, integrity: artifact.integrity },
  });
}

function state(): ReleaseState {
  return {
    version: "1.2.3",
    target: "windows-x64",
    commit: revision,
    completed: [],
    hashes: { "orc.exe": "c".repeat(64) },
  };
}

describe("npm release acceptance", () => {
  test("should wait for both metadata and archive propagation before accepting a release", async () => {
    const artifact = prepared();
    let time = 0;
    let polls = 0;
    const fetcher: ReleaseFetch = async (url) => {
      expect(url).toContain("release_check=");
      const path = new URL(url).pathname;
      if (path.endsWith("/1.2.3"))
        return ++polls === 1 ? new Response(null, { status: 404 }) : metadata(artifact);
      if (path.endsWith(".tgz"))
        return polls === 2 ? new Response(null, { status: 404 }) : new Response(bytes);
      return Response.json({ version: polls === 3 ? "1.2.2" : "1.2.3" });
    };
    await waitForNpmPublication("1.2.3", artifact, {
      fetcher,
      now: () => time,
      sleep: async (ms) => {
        time += ms;
      },
      intervalMs: 5,
      timeoutMs: 20,
      log: () => {},
    });
    expect(polls).toBe(4);
    expect(time).toBe(15);
  });

  test("should bound a publication that remains unavailable", async () => {
    let time = 0;
    await expect(
      waitForNpmPublication("1.2.3", prepared(), {
        fetcher: async () => new Response(null, { status: 404 }),
        now: () => time,
        sleep: async (ms) => {
          time += ms;
        },
        intervalMs: 10,
        timeoutMs: 20,
        log: () => {},
      }),
    ).rejects.toThrow("will not be republished");
    expect(time).toBe(20);
  });

  test("should not republish an accepted archive when resuming during processing", async () => {
    const artifact = prepared();
    let publishes = 0;
    const options = {
      fetcher: async (): Promise<Response> => new Response(null, { status: 404 }),
      command: (() => {
        expect(artifact.submittedAt).toBeDefined();
        publishes++;
        return "";
      }) as ReleaseCommand,
      wait: async (): Promise<void> => {
        throw new Error("registry processing");
      },
    };
    await expect(publishNpmArtifact("1.2.3", artifact, () => {}, options)).rejects.toThrow(
      "registry processing",
    );
    await expect(publishNpmArtifact("1.2.3", artifact, () => {}, options)).rejects.toThrow(
      "registry processing",
    );
    expect(publishes).toBe(1);
  });

  test("should never publish again when metadata is visible but archive delivery is delayed", async () => {
    const artifact = prepared();
    let publishes = 0;
    let waits = 0;
    await publishNpmArtifact("1.2.3", artifact, () => {}, {
      fetcher: async () => metadata(artifact),
      command: () => {
        publishes++;
        return "";
      },
      wait: async () => {
        waits++;
      },
    });
    expect(publishes).toBe(0);
    expect(waits).toBe(1);
  });

  test("should retain an uncertain submission and verify it instead of repeating a timed-out publish", async () => {
    const artifact = prepared();
    let publishes = 0;
    const options = {
      fetcher: async (): Promise<Response> => new Response(null, { status: 404 }),
      command: (): string => {
        publishes++;
        throw new Error("ETIMEDOUT");
      },
      wait: async (): Promise<void> => {
        throw new Error("still processing");
      },
    };
    await expect(publishNpmArtifact("1.2.3", artifact, () => {}, options)).rejects.toThrow(
      "still processing",
    );
    await expect(publishNpmArtifact("1.2.3", artifact, () => {}, options)).rejects.toThrow(
      "still processing",
    );
    expect(publishes).toBe(1);
    expect(artifact.submittedAt).toBeDefined();
  });

  test("should not publish over an existing version whose artifact evidence differs", async () => {
    let publishes = 0;
    await expect(
      publishNpmArtifact("1.2.3", prepared(), () => {}, {
        fetcher: async () =>
          Response.json({ version: "1.2.3", dist: { shasum: "other", integrity: "other" } }),
        command: () => {
          publishes++;
          return "";
        },
      }),
    ).rejects.toThrow("metadata differs");
    expect(publishes).toBe(0);
  });

  test("should redact authentication errors and allow a corrected authentication retry", async () => {
    const artifact = prepared();
    await expect(
      publishNpmArtifact("1.2.3", artifact, () => {}, {
        fetcher: async () => new Response(null, { status: 404 }),
        command: () => {
          throw new Error("EOTP private authentication diagnostics");
        },
      }),
    ).rejects.toThrow("Correct npm authentication/configuration");
    expect(artifact.submittedAt).toBeUndefined();
  });

  test("should reject a changed prepared archive before contacting npm", async () => {
    const artifact = prepared();
    writeFileSync(artifact.file, "different archive");
    let contacted = false;
    await expect(
      publishNpmArtifact("1.2.3", artifact, () => {}, {
        fetcher: async () => {
          contacted = true;
          return new Response(null, { status: 404 });
        },
      }),
    ).rejects.toThrow("prepared npm archive changed");
    expect(contacted).toBe(false);
  });

  test("should reject differing downloaded bytes even when metadata matches", async () => {
    const artifact = prepared();
    await expect(
      verifyNpmPublication("1.2.3", artifact, {
        fetcher: async (url) =>
          new URL(url).pathname.endsWith(".tgz") ? new Response("wrong bytes") : metadata(artifact),
      }),
    ).rejects.toThrow("Downloaded npm archive differs");
  });

  test("should reject a release that is not npm latest", async () => {
    const artifact = prepared();
    await expect(
      verifyNpmPublication("1.2.3", artifact, {
        fetcher: async (url) => {
          const path = new URL(url).pathname;
          if (path.endsWith(".tgz")) return new Response(bytes);
          if (path.endsWith("latest")) return Response.json({ version: "1.2.4" });
          return metadata(artifact);
        },
      }),
    ).rejects.toThrow("npm latest");
  });
});

describe("Docker release acceptance", () => {
  test("should not push either public tag when a candidate cannot start", () => {
    let pushed = false;
    expect(() =>
      publishDockerRelease(folder, state(), () => {}, {
        command: (_tool, args) => {
          if (args.includes("--push")) pushed = true;
          return "orc-multiarch";
        },
        smoke: () => {
          throw new Error("entrypoint exited127");
        },
      }),
    ).toThrow("entrypoint exited127");
    expect(pushed).toBe(false);
  });

  test("should resume published runtime validation without rebuilding or pushing again", () => {
    const release = state();
    let pushes = 0;
    let builds = 0;
    const leaves = {
      "linux/amd64": `niradler/orc@sha256:${"d".repeat(64)}`,
      "linux/arm64": `niradler/orc@sha256:${"e".repeat(64)}`,
    };
    const command: ReleaseCommand = (_tool, args) => {
      if (args.includes("--push")) pushes++;
      if (args.includes("--load")) builds++;
      if (args.includes("--raw"))
        return JSON.stringify({
          manifests: Object.entries(leaves).map(([platform, image]) => ({
            digest: image.split("@")[1],
            platform: { os: platform.split("/")[0], architecture: platform.split("/")[1] },
          })),
        });
      return "orc-multiarch";
    };
    expect(() =>
      publishDockerRelease(folder, release, () => {}, {
        command,
        verify: () => digest,
        smoke: ({ pull }) => {
          if (pull) throw new Error("published runtime failed");
        },
      }),
    ).toThrow("published runtime failed");
    expect(release.docker_digest).toBe(digest);
    expect(release.docker_runtime_verified).toBeUndefined();
    const checked: string[] = [];
    publishDockerRelease(folder, release, () => {}, {
      command,
      verify: () => digest,
      smoke: ({ image, platform, pull }) => {
        expect(pull).toBe(true);
        expect(image).toBe(leaves[platform as keyof typeof leaves]);
        checked.push(platform);
      },
    });
    expect(pushes).toBe(1);
    expect(builds).toBe(2);
    expect(checked).toEqual(["linux/amd64", "linux/arm64"]);
  });

  test("should resolve each platform to its own immutable manifest instead of pulling the shared index twice", () => {
    const first = `sha256:${"d".repeat(64)}`;
    const second = `sha256:${"e".repeat(64)}`;
    const images = publishedDockerImages(digest, (_tool, args) => {
      expect(args).toContain(`niradler/orc@${digest}`);
      return JSON.stringify({
        manifests: [
          { digest: first, platform: { os: "linux", architecture: "amd64" } },
          { digest: second, platform: { os: "linux", architecture: "arm64" } },
          { digest: "attestation", platform: { os: "unknown", architecture: "unknown" } },
        ],
      });
    });
    expect(images).toEqual({
      "linux/amd64": `niradler/orc@${first}`,
      "linux/arm64": `niradler/orc@${second}`,
    });
    expect(() => publishedDockerImages(digest, () => JSON.stringify({ manifests: [] }))).toThrow(
      "Missing immutable Docker image",
    );
  });

  test("should reject latest tag drift or a missing architecture", () => {
    const manifest = JSON.stringify({
      manifests: [{ platform: { os: "linux", architecture: "amd64" } }],
    });
    expect(() => verifyDockerPublication("1.2.3", { command: () => manifest })).toThrow(
      "linux/arm64",
    );
    expect(() =>
      verifyDockerPublication("1.2.3", {
        command: (_tool, args) =>
          args.includes("niradler/orc:latest") ? "other manifest" : manifest,
      }),
    ).toThrow("latest differs");
  });
});

describe("GitHub release acceptance", () => {
  function githubCommand(
    options: { digest?: string; latest?: string; remote?: string } = {},
  ): ReleaseCommand {
    return (tool, args) => {
      if (tool === "git") return `${options.remote ?? revision}\trefs/tags/v1.2.3^{}`;
      if (args.includes("repos/niradler/orc/releases/latest"))
        return JSON.stringify({ tag_name: options.latest ?? "v1.2.3" });
      return JSON.stringify({
        tag_name: "v1.2.3",
        draft: false,
        prerelease: false,
        assets: [
          { name: "orc.exe", digest: options.digest ?? `sha256:${"c".repeat(64)}` },
          { name: "checksums.txt" },
        ],
      });
    };
  }

  test("should verify remote tag, asset digests, latest pointer and published checksum associations", async () => {
    await verifyGitHubPublication(state(), {
      command: githubCommand(),
      fetcher: async () => new Response(`${"c".repeat(64)}  orc.exe\n`),
    });
    await expect(
      verifyGitHubPublication(state(), { command: githubCommand({ remote: "d".repeat(40) }) }),
    ).rejects.toThrow("Remote release tag");
    await expect(
      verifyGitHubPublication(state(), { command: githubCommand({ digest: "sha256:wrong" }) }),
    ).rejects.toThrow("artifact digest differs");
    await expect(
      verifyGitHubPublication(state(), { command: githubCommand({ latest: "v1.2.2" }) }),
    ).rejects.toThrow("GitHub latest");
    await expect(
      verifyGitHubPublication(state(), {
        command: githubCommand(),
        fetcher: async () => new Response(`${"c".repeat(64)}  other.exe\n`),
      }),
    ).rejects.toThrow("checksum file differs");
  });
});

describe("release completion", () => {
  test("should publish a summary once and verify that the remote saved its exact content", () => {
    let body = "Authored feature notes.";
    let edits = 0;
    const command: ReleaseCommand = (_tool, args) => {
      if (args[0] === "api") return JSON.stringify({ body });
      edits++;
      body = readFileSync(args[args.indexOf("--notes-file") + 1] ?? "", "utf8");
      return "";
    };
    const release = { ...state(), docker_digest: digest };
    publishReleaseNotes(folder, release, command);
    publishReleaseNotes(folder, release, command);
    expect(edits).toBe(1);
    expect(body).toContain("Authored feature notes.");
    expect(() =>
      publishReleaseNotes(folder, release, (_tool, args) =>
        args[0] === "api" ? JSON.stringify({ body: "Unchanged remote" }) : "",
      ),
    ).toThrow("did not match");
  });
  test("should not treat installation as completion when publication or final verification is missing", () => {
    const release = state();
    release.completed = ["install"];
    expect(releaseIsComplete(release)).toBe(false);
    release.completed = [...RELEASE_STAGES];
    expect(releaseIsComplete(release)).toBe(true);
    release.verification_required = true;
    expect(releaseIsComplete(release)).toBe(false);
    release.completed.push("verify");
    expect(releaseIsComplete(release)).toBe(true);
  });

  test("should preserve authored release notes and update the managed summary without duplication", () => {
    const original = "# Release notes\n\nA feature description written by the maintainer.\n";
    const first = verifiedReleaseNotes(original, "1.2.3", digest);
    expect(first).toContain(original.trim());
    expect(first).toContain("orc-ai@1.2.3");
    const nextDigest = `sha256:${"e".repeat(64)}`;
    const updated = verifiedReleaseNotes(first, "1.2.3", nextDigest);
    expect(updated.match(/## Verified release/g)).toHaveLength(1);
    expect(updated).not.toContain(digest);
    expect(updated).toContain(nextDigest);
    expect(verifiedReleaseNotes(updated, "1.2.3", nextDigest)).toBe(updated);
    expect(() =>
      verifiedReleaseNotes(
        "Authored notes\n<!-- ORC-RELEASE-VERIFICATION:START -->",
        "1.2.3",
        digest,
      ),
    ).toThrow("refusing to overwrite");
  });
});
