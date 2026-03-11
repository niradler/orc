const targets = [
  { target: "bun-linux-x64", out: "dist/orc-linux-x64" },
  { target: "bun-linux-arm64", out: "dist/orc-linux-arm64" },
  { target: "bun-darwin-arm64", out: "dist/orc-mac-arm64" },
  { target: "bun-darwin-x64", out: "dist/orc-mac-x64" },
  { target: "bun-windows-x64", out: "dist/orc.exe" },
] as const;

for (const { target, out } of targets) {
  console.log(`Building ${out}...`);
  await Bun.build({
    entrypoints: ["./src/index.ts"],
    outfile: out,
    target: target as Parameters<typeof Bun.build>[0]["target"],
    compile: true,
    minify: true,
  });
}

console.log("All builds complete.");
