import { run } from "./release-lib.js";
import {
  assertReleaseVersion,
  DOCKER_PLATFORMS,
  publishedDockerImages,
  type ReleaseCommand,
  type ReleaseState,
  smokeDockerImage,
  verifyDockerPublication,
} from "./release-verification.js";

export function publishDockerRelease(
  root: string,
  state: ReleaseState,
  save: () => void,
  options: {
    command?: ReleaseCommand;
    smoke?: typeof smokeDockerImage;
    verify?: typeof verifyDockerPublication;
    images?: typeof publishedDockerImages;
  } = {},
): void {
  assertReleaseVersion(state.version);
  if (!state.commit || !/^[a-f0-9]{40}$/.test(state.commit))
    throw new Error("Missing release source revision");
  const command = options.command ?? run;
  const smoke = options.smoke ?? smokeDockerImage;
  const verify = options.verify ?? verifyDockerPublication;
  if (!state.docker_digest) {
    const builders = command("docker", ["buildx", "ls", "--format", "{{.Name}}"], {
      capture: true,
      timeout: 30_000,
    }).split(/\r?\n/);
    if (!builders.includes("orc-multiarch"))
      command(
        "docker",
        ["buildx", "create", "--name", "orc-multiarch", "--driver", "docker-container"],
        { timeout: 30_000 },
      );
    const common = [
      "buildx",
      "build",
      "--builder",
      "orc-multiarch",
      "--label",
      `org.opencontainers.image.revision=${state.commit}`,
      "--label",
      `org.opencontainers.image.version=${state.version}`,
    ];
    for (const platform of DOCKER_PLATFORMS) {
      const candidate = `orc-release-candidate:${state.version}-${platform.split("/")[1]}`;
      command("docker", [...common, "--platform", platform, "--load", "-t", candidate, "."], {
        cwd: root,
        timeout: 30 * 60_000,
      });
      smoke({
        version: state.version,
        platform,
        image: candidate,
        pull: false,
        revision: state.commit,
        command,
      });
    }
    command(
      "docker",
      [
        ...common,
        "--platform",
        DOCKER_PLATFORMS.join(","),
        "--push",
        "-t",
        `niradler/orc:${state.version}`,
        "-t",
        "niradler/orc:latest",
        ".",
      ],
      { cwd: root, timeout: 30 * 60_000 },
    );
    state.docker_digest = verify(state.version, { command });
    state.docker_revision = state.commit;
    save();
  } else {
    verify(state.version, { command, digest: state.docker_digest });
  }
  const images = (options.images ?? publishedDockerImages)(state.docker_digest, command);
  for (const platform of DOCKER_PLATFORMS)
    smoke({
      version: state.version,
      platform,
      image: images[platform],
      pull: true,
      revision: state.docker_revision ?? state.commit,
      command,
    });
  state.docker_runtime_verified = [...DOCKER_PLATFORMS];
  save();
}
