import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const guide = [
  {
    text: "Start",
    items: [
      { text: "What is ORC", link: "/guide/what-is-orc" },
      { text: "Install", link: "/guide/install" },
      { text: "Quick start", link: "/guide/quick-start" },
      { text: "Connect your agents", link: "/guide/connect-agents" },
      { text: "Concepts", link: "/guide/concepts" },
    ],
  },
  {
    text: "Interfaces",
    items: [
      { text: "Desktop and web app", link: "/guide/desktop-and-web" },
      { text: "CLI", link: "/guide/cli" },
      { text: "MCP", link: "/guide/mcp" },
      { text: "REST API", link: "/guide/api" },
      { text: "Skills", link: "/guide/skills" },
    ],
  },
  {
    text: "Run ORC",
    items: [
      { text: "Self-hosted and cloud", link: "/guide/self-hosted" },
      { text: "Configuration", link: "/guide/configuration" },
    ],
  },
  {
    text: "Work with agents",
    items: [
      { text: "Usage guide", link: "/guide/usage-guide" },
      { text: "Task flows", link: "/guide/task-flows" },
      { text: "Live sessions", link: "/guide/live-sessions" },
      { text: "Session handoff", link: "/guide/session-handoff" },
      { text: "Terminal workspace", link: "/guide/terminal-workspace" },
      { text: "Questions and approvals", link: "/guide/human-requests" },
      { text: "Commands needing input", link: "/guide/command-requests" },
      { text: "Agent rules", link: "/guide/agent-rules" },
      { text: "Agent packages", link: "/guide/agent-packages" },
    ],
  },
];

const develop = [
  {
    text: "Contributing",
    items: [
      { text: "Development", link: "/develop/development" },
      { text: "Releases", link: "/develop/releases" },
      { text: "QA checklist", link: "/develop/qa-checklist" },
    ],
  },
  {
    text: "Design",
    items: [
      { text: "Vision", link: "/develop/vision" },
      { text: "Roadmap", link: "/develop/roadmap" },
      { text: "Agent orchestration", link: "/develop/agent-orchestration-design" },
      { text: "Portable packages", link: "/develop/portable-packages-design" },
      { text: "Knowledge loop", link: "/develop/knowledge-loop" },
      { text: "Dashboard updates", link: "/develop/realtime" },
      { text: "Skill evaluation", link: "/develop/skill-evaluation" },
      { text: "SDLC onboarding validation", link: "/develop/sdlc-onboarding-validation" },
    ],
  },
  {
    text: "Code quality",
    collapsed: true,
    items: [
      { text: "Roadmap", link: "/develop/code-quality/" },
      { text: "API and DB", link: "/develop/code-quality/api-db" },
      { text: "Runtime", link: "/develop/code-quality/runtime" },
      { text: "Web", link: "/develop/code-quality/web" },
    ],
  },
  {
    text: "Verification records",
    collapsed: true,
    items: [
      { text: "Attention", link: "/develop/verification/attention" },
      { text: "Channels", link: "/develop/verification/channels" },
      { text: "Telegram chat", link: "/develop/verification/telegram-chat" },
      { text: "Chat keyboard", link: "/develop/verification/chat-keyboard/" },
    ],
  },
];

export default withMermaid(
  defineConfig({
    title: "ORC",
    description: "One hub for every coding agent: tasks, sessions, memory and knowledge across Claude Code, Codex and Cursor.",
    base: "/orc/",
    cleanUrls: true,
    lastUpdated: true,
    appearance: "dark",
    ignoreDeadLinks: "localhostLinks",
    head: [
      ["link", { rel: "icon", href: "/orc/logo.svg" }],
      ["link", { rel: "preconnect", href: "https://fonts.googleapis.com" }],
      ["link", { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" }],
      [
        "link",
        {
          rel: "stylesheet",
          href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
        },
      ],
    ],
    themeConfig: {
      logo: "/logo.svg",
      siteTitle: "orc",
      nav: [
        { text: "Guide", link: "/guide/what-is-orc", activeMatch: "/guide/" },
        { text: "Develop", link: "/develop/development", activeMatch: "/develop/" },
        { text: "Releases", link: "https://github.com/niradler/orc/releases" },
      ],
      sidebar: { "/guide/": guide, "/develop/": develop },
      socialLinks: [{ icon: "github", link: "https://github.com/niradler/orc" }],
      search: { provider: "local" },
      outline: { level: [2, 3] },
      editLink: {
        pattern: "https://github.com/niradler/orc/edit/master/docs/:path",
        text: "Edit this page",
      },
      footer: { message: "Released under the MIT License." },
    },
    mermaid: {
      theme: "base",
      themeVariables: {
        darkMode: true,
        fontFamily: "IBM Plex Sans, Segoe UI, sans-serif",
        fontSize: "14px",
        background: "#000000",
        primaryColor: "#1c1c1c",
        primaryTextColor: "#e5e5e5",
        primaryBorderColor: "#717171",
        secondaryColor: "#141414",
        tertiaryColor: "#0a0a0a",
        lineColor: "#a3a3a3",
        textColor: "#e5e5e5",
        clusterBkg: "#0a0a0a",
        clusterBorder: "#262626",
        edgeLabelBackground: "#141414",
        noteBkgColor: "#242424",
        noteTextColor: "#e5e5e5",
      },
    },
    vite: {
      build: { target: "es2022" },
      optimizeDeps: {
        esbuildOptions: { target: "es2022" },
        include: ["mermaid"],
      },
    },
  }),
);
