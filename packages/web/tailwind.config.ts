import type { Config } from "tailwindcss";

export default {
  darkMode: "class",
  content: [
    "./index.html",
    "./src/**/*.{ts,tsx}",
    "../../node_modules/streamdown/dist/*.js",
    "../../node_modules/@streamdown/code/dist/*.js",
    "../../node_modules/@streamdown/mermaid/dist/*.js",
  ],
  theme: {
    extend: {
      colors: {
        destructive: "rgb(var(--error) / <alpha-value>)",
        background: "rgb(var(--background) / <alpha-value>)",
        surface: {
          DEFAULT: "rgb(var(--surface) / <alpha-value>)",
          low: "rgb(var(--surface-low) / <alpha-value>)",
          high: "rgb(var(--surface-high) / <alpha-value>)",
          highest: "rgb(var(--surface-highest) / <alpha-value>)",
          bright: "rgb(var(--surface-bright) / <alpha-value>)",
        },
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        border: "rgb(var(--border) / <alpha-value>)",
        "control-border": "rgb(var(--control-border) / <alpha-value>)",
        focus: "rgb(var(--focus) / <alpha-value>)",
        progress: "rgb(var(--progress) / <alpha-value>)",
        sidebar: "rgb(var(--surface-low) / <alpha-value>)",
        muted: {
          DEFAULT: "rgb(var(--surface-highest) / <alpha-value>)",
          foreground: "rgb(var(--muted-foreground) / <alpha-value>)",
        },
        primary: {
          foreground: "rgb(var(--primary-foreground) / <alpha-value>)",
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          container: "rgb(var(--primary) / <alpha-value>)",
          dim: "rgb(var(--primary) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "rgb(var(--success) / <alpha-value>)",
          dim: "rgb(var(--success) / <alpha-value>)",
        },
        tertiary: {
          DEFAULT: "rgb(var(--warning) / <alpha-value>)",
          dim: "rgb(var(--warning) / <alpha-value>)",
        },
        "on-surface": "rgb(var(--foreground) / <alpha-value>)",
        "on-surface-variant": "rgb(var(--muted-foreground) / <alpha-value>)",
        "outline-variant": "rgb(var(--border) / <alpha-value>)",
        outline: "rgb(var(--muted-foreground) / <alpha-value>)",
        error: {
          DEFAULT: "rgb(var(--error) / <alpha-value>)",
          container: "rgb(var(--error-container) / <alpha-value>)",
        },
      },
      letterSpacing: {
        widest: "0.06em",
      },
      fontFamily: {
        headline: ["IBM Plex Sans", "Segoe UI", "sans-serif"],
        body: ["IBM Plex Sans", "Segoe UI", "sans-serif"],
        label: ["IBM Plex Sans", "Segoe UI", "sans-serif"],
        mono: ["IBM Plex Mono", "Consolas", "monospace"],
      },
      borderRadius: {
        DEFAULT: "0.125rem",
        sm: "0.25rem",
        md: "0.375rem",
        lg: "0.5rem",
      },
    },
  },
  plugins: [],
} satisfies Config;
