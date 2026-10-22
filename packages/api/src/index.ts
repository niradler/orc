import { superviseServer } from "@orc/core/process-supervisor";

if (await superviseServer()) await import("./runtime.js");
