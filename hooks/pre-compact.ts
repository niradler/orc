#!/usr/bin/env bun
import { dispatchRuleHook } from "./rule-dispatch.js";

await dispatchRuleHook("PreCompact");
