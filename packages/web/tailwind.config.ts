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
        background: "#090e1a",
        surface: {
          DEFAULT: "#131928",
          low: "#0e1320",
          high: "#191f2f",
          highest: "#1e2537",
          bright: "#242c3f",
        },
        foreground: "#e1e5f6",
        border: "#434856",
        sidebar: "#0e1320",
        muted: {
          DEFAULT: "#1e2537",
          foreground: "#a6abbb",
        },
        primary: {
          foreground: "#05152e",
          DEFAULT: "#78b0ff",
          container: "#5ba2ff",
          dim: "#549fff",
        },
        secondary: {
          DEFAULT: "#70fda7",
          dim: "#61ee9a",
        },
        tertiary: {
          DEFAULT: "#ffa851",
          dim: "#eb8800",
        },
        "on-surface": "#e1e5f6",
        "on-surface-variant": "#a6abbb",
        "outline-variant": "#434856",
        outline: "#8d93a5",
        error: {
          DEFAULT: "#ff716c",
          container: "#9f0519",
        },
      },
      letterSpacing: {
        widest: "0.06em",
      },
      fontFamily: {
        headline: ["Manrope", "sans-serif"],
        body: ["Inter", "sans-serif"],
        label: ["Space Grotesk", "sans-serif"],
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
