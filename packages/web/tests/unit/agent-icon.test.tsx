import { expect, test } from "bun:test";
import { CODING_AGENT_IDS } from "@orc/core/coding-agents";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentIcon } from "../../src/components/AgentIcon";
import { AGENT_MARKS } from "../../src/components/agent-marks";

test("should have one brand mark for every coding agent", () => {
  expect(Object.keys(AGENT_MARKS).sort()).toEqual([...CODING_AGENT_IDS].sort());
});

test("should render the brand's own colour or gradient", () => {
  const claude = renderToStaticMarkup(<AgentIcon agent="claude" />);
  expect(claude).toContain('data-agent-mark="claude"');
  expect(claude).toContain('aria-label="Claude Code"');
  expect(claude).toContain("#D97757");

  const kiro = renderToStaticMarkup(<AgentIcon agent="kiro" />);
  expect(kiro).toContain("#9046FF");

  const gemini = renderToStaticMarkup(<AgentIcon agent="gemini" />);
  expect(gemini).toContain("<linearGradient");
  expect(gemini).toContain("#4285F4");

  // A monochrome brand mark follows the surrounding text colour.
  const codex = renderToStaticMarkup(<AgentIcon agent="codex" />);
  expect(codex).toContain('data-agent-mark="codex"');
  expect(codex).toContain("currentColor");
});

test("should keep decorative and fallback behaviour", () => {
  const fallback = renderToStaticMarkup(<AgentIcon agent="not-an-agent" />);
  expect(fallback).toContain('data-agent-mark="fallback"');
  expect(fallback).toContain('aria-label="not-an-agent"');

  const decorative = renderToStaticMarkup(<AgentIcon agent="claude" decorative />);
  expect(decorative).toContain('aria-hidden="true"');
  expect(decorative).not.toContain('role="img"');
});
