import { expect, test } from "bun:test";
import { ChatSettingsSchema } from "@orc/core/chat";
import { ProviderProfileSchema } from "@orc/core/providers";
import { withPreferences } from "../../src/hooks/chat-contract";
import { providerSelection } from "../../src/hooks/chat-provider-config";

const profile = (id: string, agent = "claude") =>
  ProviderProfileSchema.parse({ id, name: id, agent, enabled: true });
test("keeps unsent edits per provider across adapters without leaking same-adapter defaults", () => {
  const first = ChatSettingsSchema.parse({
    agent: "claude",
    providerId: "proxy",
    model: "custom-model",
    agentOptions: { claude: { runtime: "claude-sdk", options: { effort: "high" } } },
  });
  const codex = providerSelection(first, undefined, profile("codex", "codex"));
  const direct = providerSelection(codex.config, codex.providerDrafts, profile("claude"));
  expect(direct.config.agentOptions.claude).toBeUndefined();
  const restored = providerSelection(direct.config, direct.providerDrafts, profile("proxy"));
  expect(restored.config).toMatchObject({
    model: "custom-model",
    agentOptions: { claude: { options: { effort: "high" } } },
  });
  const gemini = providerSelection(first, undefined, profile("gemini", "gemini"));
  gemini.config.agentOptions.gemini = { runtime: "acpx", args: ["--timeout", "120"] };
  const other = providerSelection(gemini.config, gemini.providerDrafts, profile("claude"));
  const back = providerSelection(other.config, other.providerDrafts, profile("gemini", "gemini"));
  expect(back.config.agentOptions.gemini).toEqual({ runtime: "acpx", args: ["--timeout", "120"] });
});
test("restores an explicit browser permission choice consistently with Claude SDK defaults", () => {
  const saved = ChatSettingsSchema.parse({
    agent: "claude",
    providerId: "work",
    agentOptions: {
      claude: { runtime: "claude-sdk", options: { permissionMode: "bypassPermissions" } },
    },
  });
  expect(
    withPreferences(saved, { providerId: "work", agent: "claude", permissionMode: "default" }),
  ).toMatchObject({
    permissionMode: "default",
    agentOptions: { claude: { options: { permissionMode: "default" } } },
  });
});
