---
name: procedural-skill-creator
description: Create, patch, or improve a procedural skill using the extension's skill tool. Use when recent work should be captured as a reusable global or project-scoped procedure.
---

# Procedural Skill Creator

Turn recent work into a durable procedural skill managed by the extension `skill` tool.

## Goal

Capture repeatable **how-to workflows** so future agents can execute them reliably.

- `create` when no skill covers the workflow.
- `patch` when an existing skill should absorb new learning.
- skip extraction when the work is one-off.

## Operating Principle

Extract from what already happened first (conversation, commands, edits, failures, fixes).
Ask follow-up questions only if critical details are missing.

## Extraction Gate

Save a skill only if all checks pass:

1. Multi-step workflow (not a single trivial action)
2. Likely to recur
3. Includes non-obvious pitfalls/decision points
4. Can be verified with concrete pass/fail checks

If any check fails, respond exactly:

`Nothing to extract.`

## Scope Decision

- `global`: portable across repos/projects
- `project`: depends on this repo's paths, scripts, architecture, or conventions

Heuristic: if repo-specific paths or commands are required, use `project`.

## Global Skill De-duplication Protocol

Before creating a **global** skill, prevent overlap with existing global skills.

1. List skills with `skill(action="view")`.
2. Filter to `scope=global`.
3. Compare candidate against existing skills in three passes:
   - **Name pass**: exact slug match or near-name match (same core verb+noun)
   - **Description pass**: same trigger intent / same expected outcome
   - **Procedure pass**: substantially same step sequence
4. Decide action:
   - **Exact same name/intent** → do **not** create; use `patch`/`edit`
   - **Different name, same intent** → merge into existing skill (patch existing), avoid duplicate
   - **Adjacent but distinct intent** → create new skill with sharper boundary in `When to Use`

If uncertain between two similar skills, run a tie-breaker:
- ask: "Would both skills trigger for the same user prompt and produce the same outcome?"
- if yes, merge; if no, keep separate and clarify boundaries.

Default bias: **merge over duplicate**.

## Action Decision

- `create`: no existing skill covers the core job
- `patch`: existing skill exists; improve only changed section(s)

Prefer patching over creating overlapping skills.

## Workflow

1. **Capture intent**
   - What job should this skill enable?
   - When should it trigger?
   - What outcome should it produce?
2. **Collect evidence from recent work**
   - successful sequence
   - dead ends and corrections
   - verification signals
3. **Run de-dup check** (required for global scope)
4. **Decide** `create` / `patch` / `Nothing to extract.`
5. **Draft or revise** using required sections:
   - `## When to Use`
   - `## Procedure`
   - `## Pitfalls`
   - `## Verification`
6. **Run a lightweight eval pass** (before saving):
   - one normal case
   - one edge case
   - one near-miss (should *not* use this skill)
   Refine if ambiguous.
7. **Persist with `skill` tool**
   - create: `name`, `description`, `scope` (always explicit), full body
   - patch: `skill_id`, `section`, section content

## Authoring Standards

### Name

- short kebab-case (`debug-ci-timeouts`, `backfill-flag-rollout`)
- name the reusable job, not the incident

### Description (Trigger Quality)

The description is the main trigger signal.
Include:
- what it does
- when to use it
- nearby phrasing users might use

Be explicit enough to avoid under-triggering, without becoming spammy.

### Section Quality

- **When to Use**: trigger conditions + boundaries
- **Procedure**: ordered, actionable steps
- **Pitfalls**: frequent failure modes + prevention
- **Verification**: concrete checks (tests, logs, files, outputs)

## Generalization Guardrails

- Don’t overfit to one transcript.
- Explain *why* key steps matter when non-obvious.
- Prefer principles + steps over rigid cargo-cult rules.
- Keep it lean; remove steps that do not change outcomes.

## Patch Guidance

When patching:

- use existing `skill_id`
- patch only changed section(s)
- prioritize `Procedure`, `Pitfalls`, `Verification`
- avoid rewriting unrelated content

## Rules

- Use `skill` tool only (no direct file writes).
- Prefer one strong skill over many near-duplicates.
- Do not store temporary task state, ticket notes, or one-off results.

## Completion Standard

A saved skill must allow a future agent to execute the workflow with minimal guesswork and clear verification.
If not, refine before saving.
