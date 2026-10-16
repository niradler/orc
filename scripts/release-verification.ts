import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { run } from "./release-lib.js";

export type ReleaseCommand = typeof run;
export type ReleaseFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type NpmArtifact = { file: string; shasum: string; integrity: string; submittedAt?: number };
export type ReleaseState = {
  version: string;
  target: string;
  commit?: string;
  runId?: number;
  completed: string[];
  hashes?: Record<string, string>;
  npm?: NpmArtifact;
  docker_digest?: string;
  docker_revision?: string;
  docker_runtime_verified?: string[];
  verification_required?: boolean;
};

const REGISTRY = "https://registry.npmjs.org";
export const DOCKER_PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export const RELEASE_STAGES = [
  "checks",
  "bump",
  "build",
  "tag",
  "actions",
  "github",
  "npm",
  "docker",
  "install",
] as const;

export function releaseIsComplete(state: ReleaseState): boolean {
  return (
    RELEASE_STAGES.every((stage) => state.completed.includes(stage)) &&
    (!state.verification_required || state.completed.includes("verify"))
  );
}

export function assertReleaseVersion(version: string): void {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid stable release version");
}

export function npmArtifact(file: string): NpmArtifact {
  const bytes = readFileSync(file);
  return {
    file,
    shasum: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export function assertNpmArtifact(artifact: NpmArtifact): void {
  const current = npmArtifact(artifact.file);
  if (current.shasum !== artifact.shasum || current.integrity !== artifact.integrity)
    throw new Error("The prepared npm archive changed; refusing publication");
}

async function registryRead(path: string, fetcher: ReleaseFetch): Promise<Response> {
  return fetcher(`${REGISTRY}${path}?release_check=${Date.now()}`, {
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(30_000),
  });
}

function isOlderVersion(actual: string, expected: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(actual)) return false;
  const left = actual.split(".").map(Number);
  const right = expected.split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const first = left[index] ?? 0;
    const second = right[index] ?? 0;
    if (first !== second) return first < second;
  }
  return false;
}

async function npmMetadataExists(
  version: string,
  artifact: NpmArtifact,
  fetcher: ReleaseFetch,
): Promise<boolean> {
  assertReleaseVersion(version);
  const response = await registryRead(`/orc-ai/${version}`, fetcher);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`npm registry verification failed (${response.status})`);
  const entry = (await response.json()) as {
    version?: string;
    dist?: { shasum?: string; integrity?: string };
  };
  if (
    entry.version !== version ||
    entry.dist?.shasum !== artifact.shasum ||
    entry.dist.integrity !== artifact.integrity
  )
    throw new Error("Published npm metadata differs from the prepared release archive");
  return true;
}

export async function verifyNpmPublication(
  version: string,
  artifact: NpmArtifact,
  options: { fetcher?: ReleaseFetch; latest?: boolean } = {},
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  if (!(await npmMetadataExists(version, artifact, fetcher))) return false;
  const archive = await registryRead(`/orc-ai/-/orc-ai-${version}.tgz`, fetcher);
  if (archive.status === 404) return false;
  if (!archive.ok) throw new Error(`npm archive verification failed (${archive.status})`);
  const bytes = Buffer.from(await archive.arrayBuffer());
  if (
    createHash("sha1").update(bytes).digest("hex") !== artifact.shasum ||
    `sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity
  )
    throw new Error("Downloaded npm archive differs from the prepared release archive");
  if (options.latest !== false) {
    const latest = await registryRead("/orc-ai/latest", fetcher);
    if (latest.status === 404) return false;
    if (!latest.ok) throw new Error(`npm latest verification failed (${latest.status})`);
    const current = (await latest.json()) as { version?: string };
    if (current.version !== version) {
      if (typeof current.version === "string" && isOlderVersion(current.version, version))
        return false;
      throw new Error("npm latest does not point to this release");
    }
  }
  return true;
}

export async function waitForNpmPublication(
  version: string,
  artifact: NpmArtifact,
  options: {
    fetcher?: ReleaseFetch;
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<unknown>;
    log?: (message: string) => void;
  } = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;
  const deadline = now() + (options.timeoutMs ?? 10 * 60_000);
  let nextMessage = 0;
  while (true) {
    if (
      await verifyNpmPublication(
        version,
        artifact,
        options.fetcher ? { fetcher: options.fetcher } : {},
      )
    )
      return;
    if (now() >= deadline)
      throw new Error(
        "npm publication is not public yet. Resume to verify again; the accepted archive will not be republished.",
      );
    if (now() >= nextMessage) {
      (options.log ?? console.log)(
        "npm is processing the submitted archive; waiting for public checksum verification…",
      );
      nextMessage = now() + 60_000;
    }
    await sleep(Math.min(options.intervalMs ?? 15_000, Math.max(0, deadline - now())));
  }
}

export async function publishNpmArtifact(
  version: string,
  artifact: NpmArtifact,
  save: () => void,
  options: {
    command?: ReleaseCommand;
    fetcher?: ReleaseFetch;
    wait?: typeof waitForNpmPublication;
  } = {},
): Promise<void> {
  assertReleaseVersion(version);
  assertNpmArtifact(artifact);
  const command = options.command ?? run;
  if (
    !(await npmMetadataExists(version, artifact, options.fetcher ?? fetch)) &&
    artifact.submittedAt === undefined
  ) {
    artifact.submittedAt = Date.now();
    save();
    try {
      command(
        "npm",
        [
          "publish",
          artifact.file,
          "--ignore-scripts",
          "--access",
          "public",
          "--tag",
          "latest",
          "--registry",
          REGISTRY,
        ],
        { timeout: 120_000, capture: true, quiet: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/\b(?:EOTP|E401|E403|ENEEDAUTH|E400)\b/.test(message)) {
        delete artifact.submittedAt;
        save();
        throw new Error(
          "npm rejected publication. Correct npm authentication/configuration and resume.",
        );
      }
      console.log(
        "npm publication outcome is uncertain; checking the public registry before any retry.",
      );
    }
  }
  await (options.wait ?? waitForNpmPublication)(
    version,
    artifact,
    options.fetcher ? { fetcher: options.fetcher } : {},
  );
}

export function verifyDockerPublication(
  version: string,
  options: { command?: ReleaseCommand; digest?: string } = {},
): string {
  assertReleaseVersion(version);
  const command = options.command ?? run;
  const image = `niradler/orc:${version}`;
  const inspect = (reference: string): string =>
    command("docker", ["buildx", "imagetools", "inspect", reference, "--raw"], {
      capture: true,
      timeout: 30_000,
      quiet: true,
    });
  const raw = inspect(image);
  if (raw !== inspect("niradler/orc:latest"))
    throw new Error("Docker latest differs from the release image");
  const manifest = JSON.parse(raw) as {
    manifests?: { platform?: { os?: string; architecture?: string } }[];
  };
  for (const platform of DOCKER_PLATFORMS) {
    const [os, architecture] = platform.split("/");
    if (
      !manifest.manifests?.some(
        (entry) => entry.platform?.os === os && entry.platform?.architecture === architecture,
      )
    )
      throw new Error(`Published Docker image is missing ${platform}`);
  }
  const output = command("docker", ["buildx", "imagetools", "inspect", image], {
    capture: true,
    timeout: 30_000,
    quiet: true,
  });
  const digest = output.match(/^Digest:\s+(sha256:[a-f0-9]{64})\s*$/m)?.[1];
  if (!digest || (options.digest && options.digest !== digest))
    throw new Error("Published Docker digest differs from the checkpoint");
  return digest;
}

export function publishedDockerImages(
  digest: string,
  command: ReleaseCommand = run,
): Record<(typeof DOCKER_PLATFORMS)[number], string> {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid published Docker digest");
  const manifest = JSON.parse(
    command("docker", ["buildx", "imagetools", "inspect", `niradler/orc@${digest}`, "--raw"], {
      capture: true,
      timeout: 30_000,
      quiet: true,
    }),
  ) as {
    manifests?: { digest?: string; platform?: { os?: string; architecture?: string } }[];
  };
  const images = {} as Record<(typeof DOCKER_PLATFORMS)[number], string>;
  for (const platform of DOCKER_PLATFORMS) {
    const [os, architecture] = platform.split("/");
    const entry = manifest.manifests?.find(
      (item) => item.platform?.os === os && item.platform?.architecture === architecture,
    );
    if (!entry?.digest || !/^sha256:[a-f0-9]{64}$/.test(entry.digest))
      throw new Error(`Missing immutable Docker image for ${platform}`);
    images[platform] = `niradler/orc@${entry.digest}`;
  }
  return images;
}

export function dockerSmokeProgram(version: string, architecture: "x64" | "arm64"): string {
  assertReleaseVersion(version);
  if (!["x64", "arm64"].includes(architecture)) throw new Error("Invalid image architecture");
  return `
const expected = ${JSON.stringify(version)};
if(process.platform!=="linux"||process.arch!==${JSON.stringify(architecture)})throw Error("Image architecture mismatch");
const secret = crypto.randomUUID();
const child = Bun.spawn([process.execPath, "run", "packages/cli/src/index.ts", "daemon", "start"], {
  env:{...process.env,ORC_API_SECRET:secret,ORC_AGENT_LOOP_ENABLED:"false",ORC_API_PORT:"7700"},
  stdout:"ignore",stderr:"inherit"
});
try {
  const base="http://127.0.0.1:7700";
  let health;
  const deadline=Date.now()+90000;
  while(Date.now()<deadline) {
    try {const r=await fetch(base+"/api/health",{signal:AbortSignal.timeout(2000)});if(r.ok){health=await r.json();break;}}catch{}
    if(child.exitCode!==null)throw Error("Image daemon exited before becoming healthy");
    await Bun.sleep(500);
  }
  if(health?.version!==expected)throw Error("Image API version mismatch");
  const denied=await fetch(base+"/api/tasks",{signal:AbortSignal.timeout(10000)});
  if(denied.status!==401)throw Error("Image API authentication failed");
  const allowed=await fetch(base+"/api/tasks",{headers:{authorization:"Bearer "+secret},signal:AbortSignal.timeout(10000)});
  if(!allowed.ok)throw Error("Authenticated image API failed");
  const web=await fetch(base+"/",{headers:{accept:"text/html"},signal:AbortSignal.timeout(10000)});
  const html=await web.text();
  const asset=html.match(/<script[^>]*src="([^"]*\\/assets\\/[^"]+)"/i)?.[1];
  if(!web.ok||!asset)throw Error("Image dashboard is missing");
  const url=new URL(asset,base);
  if(url.origin!==base)throw Error("Unexpected dashboard asset origin");
  const resource=await fetch(url,{signal:AbortSignal.timeout(10000)});
  if(!resource.ok||(await resource.arrayBuffer()).byteLength===0)throw Error("Image dashboard asset is missing");
  console.log("Image runtime verified: version, authentication, dashboard and asset");
} finally {child.kill();if(await child.exited!==0)throw Error("Image daemon did not shut down cleanly");}
`;
}

export function smokeDockerImage(options: {
  version: string;
  platform: string;
  image: string;
  pull: boolean;
  revision: string;
  command?: ReleaseCommand;
}): void {
  if (
    !DOCKER_PLATFORMS.some((platform) => platform === options.platform) ||
    !/^[a-f0-9]{40}$/.test(options.revision)
  )
    throw new Error("Invalid Docker smoke target");
  const command = options.command ?? run;
  if (options.pull)
    command("docker", ["pull", "--platform", options.platform, options.image], {
      timeout: 10 * 60_000,
    });
  const name = `orc-release-${options.version}-${options.platform.replace("/", "-")}-${crypto.randomUUID()}`;
  command(
    "docker",
    [
      "run",
      "--pull=never",
      "--name",
      name,
      "--platform",
      options.platform,
      options.image,
      "bun",
      "-e",
      dockerSmokeProgram(options.version, options.platform === "linux/amd64" ? "x64" : "arm64"),
    ],
    { timeout: 150_000, quiet: true },
  );
  const revision = command(
    "docker",
    ["inspect", name, "--format", '{{index .Config.Labels "org.opencontainers.image.revision"}}'],
    { capture: true, timeout: 10_000, quiet: true },
  );
  if (revision !== options.revision)
    throw new Error("Image source revision differs from the release checkpoint");
}

export async function verifyGitHubPublication(
  state: ReleaseState,
  options: { command?: ReleaseCommand; fetcher?: ReleaseFetch } = {},
): Promise<void> {
  assertReleaseVersion(state.version);
  if (
    !state.commit ||
    !/^[a-f0-9]{40}$/.test(state.commit) ||
    !state.hashes ||
    !Object.keys(state.hashes).length
  )
    throw new Error("Release checkpoint is missing source/artifact evidence");
  const command = options.command ?? run;
  const tag = `v${state.version}`;
  const remote = command("git", ["ls-remote", "origin", `refs/tags/${tag}^{}`], {
    capture: true,
    timeout: 30_000,
    quiet: true,
  }).split(/\s+/)[0];
  if (remote !== state.commit) throw new Error("Remote release tag differs from the checkpoint");
  const release = JSON.parse(
    command("gh", ["api", `repos/niradler/orc/releases/tags/${tag}`], {
      capture: true,
      timeout: 30_000,
      quiet: true,
    }),
  ) as {
    draft?: boolean;
    prerelease?: boolean;
    tag_name?: string;
    assets?: { name?: string; digest?: string }[];
  };
  if (
    release.draft !== false ||
    release.prerelease !== false ||
    release.tag_name !== tag ||
    release.assets?.length !== Object.keys(state.hashes).length + 1
  )
    throw new Error("GitHub release is incomplete");
  for (const [name, hash] of Object.entries(state.hashes)) {
    if (basename(name) !== name || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Invalid release asset evidence");
    if (!release.assets.some((asset) => asset.name === name && asset.digest === `sha256:${hash}`))
      throw new Error("A GitHub release artifact digest differs from the checkpoint");
  }
  const latest = JSON.parse(
    command("gh", ["api", "repos/niradler/orc/releases/latest"], {
      capture: true,
      timeout: 30_000,
      quiet: true,
    }),
  ) as { tag_name?: string };
  if (latest.tag_name !== tag) throw new Error("GitHub latest does not point to this release");
  const checksums = await (options.fetcher ?? fetch)(
    `https://github.com/niradler/orc/releases/download/${tag}/checksums.txt`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (!checksums.ok) throw new Error("Published GitHub checksums are unavailable");
  const lines = (await checksums.text()).trim().split(/\r?\n/);
  if (
    lines.length !== Object.keys(state.hashes).length ||
    Object.entries(state.hashes).some(
      ([name, hash]) =>
        !lines.some((line) => line.trim().split(/\s+/).join(" ") === `${hash} ${name}`),
    )
  )
    throw new Error("Published GitHub checksum file differs from the release artifacts");
}
