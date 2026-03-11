#!/usr/bin/env bun
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Dashboard } from "./components/Dashboard.js";

const renderer = await createCliRenderer({ exitOnCtrlC: false });
createRoot(renderer).render(<Dashboard />);
