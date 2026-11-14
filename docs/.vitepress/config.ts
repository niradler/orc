import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

const sidebar = [
  {
    text: "Start",
    items: [
      { text: "What is ORC", link: "/docs/what-is-orc" },
      { text: "Install", link: "/docs/install" },
      { text: "Quick start", link: "/docs/quick-start" },
      { text: "Connect your agents", link: "/docs/connect-agents" },
      { text: "Concepts", link: "/docs/concepts" },
    ],
  },
  {
    text: "Interfaces",
    items: [
      { text: "Desktop and web app", link: "/docs/desktop-and-web" },
      { text: "CLI", link: "/docs/cli" },
      { text: "MCP", link: "/docs/mcp" },
      { text: "REST API", link: "/docs/api" },
      { text: "Skills", link: "/docs/skills" },
      { text: "Pi and porc", link: "/docs/pi" },
      { text: "OpenCode", link: "/docs/opencode" },
    ],
  },
  {
    text: "Run ORC",
    items: [
      { text: "Self-hosted and cloud", link: "/docs/self-hosted" },
      { text: "Configuration", link: "/docs/configuration" },
    ],
  },
  {
    text: "Work with agents",
    items: [
      { text: "Usage guide", link: "/docs/usage-guide" },
      { text: "Task flows", link: "/docs/task-flows" },
      { text: "Live sessions", link: "/docs/live-sessions" },
      { text: "Session handoff", link: "/docs/session-handoff" },
      { text: "Terminal workspace", link: "/docs/terminal-workspace" },
      { text: "Questions and approvals", link: "/docs/human-requests" },
      { text: "Notifications", link: "/docs/notifications" },
      { text: "Commands needing input", link: "/docs/command-requests" },
      { text: "Agent rules", link: "/docs/agent-rules" },
      { text: "Agent packages", link: "/docs/agent-packages" },
    ],
  },
  {
    text: "Development",
    items: [
      { text: "Contributing", link: "/development/" },
      { text: "Run locally", link: "/development/setup" },
      { text: "Build and test", link: "/development/build-and-test" },
      { text: "Releases", link: "/development/releases" },
    ],
  },
];

export default withMermaid(
  defineConfig({
    title: "ORC",
    description:
      "One hub for every coding agent: tasks, sessions, memory and knowledge across Claude Code, Codex and Cursor.",
    base: "/orc/",
    cleanUrls: true,
    srcExclude: ["internal/**", "screenshots/**"],
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
        { text: "Docs", link: "/docs/what-is-orc", activeMatch: "/docs/" },
        { text: "Contributing", link: "/development/", activeMatch: "/development/" },
        { text: "Releases", link: "https://github.com/niradler/orc/releases" },
      ],
      sidebar,
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
