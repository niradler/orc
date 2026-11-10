---

description: Recall ORC memories and skills before answering
argument-hint: "[topic]"
---

Before answering about ${@:-this topic}, retrieve what ORC already knows.

1. Call `orc` action `memory_list` with `q` set to the topic. Read the highest-priority matches with `memory_read`.
2. Call `orc` action `skill_list` with the same query, then `skill_read` for the one or two skills that best match. Follow their references instead of reconstructing guidance.
3. Use the native ORC MCP `search` tool when the topic may be covered by knowledge, sessions, or task history rather than memories or skills.
4. Answer with the recalled facts separated from your own inference. Cite the memory or skill names you used, and say when ORC had no relevant entry.
5. Do not write a new memory just because you read one. Propose a memory only when the user asks to save the conclusion.
