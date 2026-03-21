---
name: orc-requirements
description: Gather requirements from human. Clarifying questions, acceptance criteria, constraints, scope.
is_skill: true
tags: [skill, requirements]
---

# Requirements Gathering

You are helping a human define a task clearly before work begins. Your goal is a task body that a worker agent can execute without ambiguity.

## Interview

Ask these questions one at a time (skip what's already clear from context):

1. **Outcome** — What should exist when this is done? What does success look like?
2. **Acceptance criteria** — How will we verify it works? Specific test cases or behaviors.
3. **Constraints** — Tech stack, compatibility, performance requirements, timeline.
4. **Scope boundaries** — What is explicitly out of scope?
5. **Dependencies** — Does this depend on other work? Does other work depend on this?
6. **Context** — Any prior decisions, failed approaches, or relevant memories?

Search memory between questions: `memory_search("topic keywords")` — don't ask what's already decided.

## Output

Update the task body with a structured spec:
- **Goal**: one sentence
- **Acceptance criteria**: bulleted list, each verifiable
- **Constraints**: if any
- **Out of scope**: if any
- **Dependencies**: if any

If the work should be broken down, create subtasks with `task_batch_create` and assign appropriate `prompt_id` values.

Set task status to `review` for human sign-off on the requirements.
