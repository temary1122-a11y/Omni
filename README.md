# OmniFlow

![CI](https://github.com/temary1122-a11y/Omni/actions/workflows/ci.yml/badge.svg)

> **AI Agent Orchestrator for VS Code** — describe a goal in plain language and get a working, verified project delivered into your workspace.

OmniFlow is a VS Code extension that acts as an autonomous software‑delivery harness. You type what you want to build in natural language; OmniFlow clarifies the goal, then drives a **multi‑agent pipeline** (Research → Planning → Build → Audit → Security → Verification → Deliver) that designs, implements, checks, and hands the project back to you — all inside your editor.

It is **provider‑agnostic**: it routes each step to OpenRouter (including free models), Kilo Gateway, Codik, or a local Ollama, and degrades to an offline rule‑based engine when no key is configured, so it runs out of the box.

---

## Table of contents

- [What makes OmniFlow different](#what-makes-omniflow-different)
- [Features](#features)
- [How it works](#how-it-works)
  - [The adaptive pipeline](#the-adaptive-pipeline)
  - [Complexity tiers](#complexity-tiers)
  - [Harness vs. LLM: who does what](#harness-vs-llm-who-does-what)
- [Architecture](#architecture)
- [Quick start](#quick-start)
- [LLM providers & routing](#llm-providers--routing)
- [Budget control](#budget-control)
- [The agents](#the-agents)
- [Memory system](#memory-system)
- [Code intelligence](#code-intelligence)
- [Safety & the execution sandbox](#safety--the-execution-sandbox)
- [The Cockpit UI](#the-cockpit-ui)
- [Configuration reference](#configuration-reference)
- [Commands](#commands)
- [Development](#development)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Status & roadmap](#status--roadmap)
- [License](#license)

---

## What makes OmniFlow different

OmniFlow is built around a single principle borrowed from current agent research
([Anthropic — *Building effective agents*](https://www.anthropic.com/engineering/building-effective-agents)):

> **Use the LLM only where judgment is required** — reasoning, planning, design decisions,
> analysis of failures — and let a deterministic **harness** handle everything predictable
> (reading and writing files, running tests, enforcing budgets and stop conditions, routing
> providers, tracking state).

Two consequences shape the whole codebase:

1. **Ground truth comes from the environment, not from the model's words.** A file counts as
   written only after a tool call succeeds; a test counts as passing only after it actually runs.
2. **Complexity is earned.** A trivial request does not pay for an eight‑phase pipeline — the
   orchestrator scales the number of agents and phases to the task (see
   [Complexity tiers](#complexity-tiers)).

The product is aimed especially at **"vibe coders"** — people who want to build software without
deep engineering background. The Cockpit favors plain language and visible progress over jargon,
while still exposing the underlying reasoning for those who want it.

---

## Features

- **Goal clarification** — asks targeted questions before writing any code, in the user's language.
- **Adaptive multi‑agent pipeline** — an orchestrator selects which agents run based on task complexity and goal signals, instead of always running a fixed script.
- **Provider‑agnostic LLM routing** — OpenRouter, Kilo Gateway, Codik, Ollama, with a resilient health/fallback layer and an offline engine.
- **Budget‑aware model selection** — `free` / `low` / `normal` / `high` tiers map to appropriate model price tiers; free‑only stays free even after paid credits are exhausted.
- **Boundary‑enforced execution** — tool calls run in a Docker sandbox; without Docker, host execution is **off by default** and a block‑list of destructive commands is always refused.
- **Code intelligence** — a built‑in code index resolves symbols to precise coordinates (file/line), and a semantic editor performs symbol‑aware edits so agents don't re‑read whole files.
- **Layered memory** — episodic, semantic, procedural, and working memory give weak models stronger, more precise context.
- **Interactive Cockpit** — a React webview with live chat, an agent activity view, and a clear separation between the agent's *reasoning*, its *commentary* to you, and the final *delivery*.
- **Zero‑config start** — no API key needed to try it (offline fallback).

---

## How it works

### The adaptive pipeline

Every run begins with **intake** (the Clarifier). Only after intake — once the goal and its
complexity are known — does the orchestrator decide which of the remaining phases to run. Phases
are always executed in canonical order, and **deliver** always runs last.

```
intake ─▶ [research] ─▶ [planning] ─▶ build ─▶ [audit] ─▶ [security] ─▶ [verify] ─▶ deliver
   │                                                                                    ▲
   └── determines complexity + goal signals ──▶ RoleSelector picks the phases in [ ] ───┘
```

`RoleSelector` (`src/core/RoleSelector.ts`) maps complexity plus lightweight goal signals
(security / audit / planning keywords) to a concrete set of agents, then to phases. For example, a
goal mentioning *auth* or *token* pulls in the Security agent even on a lower tier; an
*architecture* or *scale* goal pulls in extra planning/research.

### Complexity tiers

The phase set per tier is declared in `src/pipeline/pipelineManifest.ts`:

| Tier | Phases run | Typical use |
|------|------------|-------------|
| **LOW** | intake → research → planning → build → deliver | Small, well‑scoped tasks |
| **MEDIUM** | intake → research → planning → build → **verify** → deliver | Real features that need validation |
| **HIGH** | intake → research → planning → build → **audit → security → verify** → deliver (+ self‑prompting convergence loop) | Complex / high‑value work at full power |

Goal signals can add specialist agents on top of the base tier, so the exact pipeline is decided
per goal rather than hardcoded.

### Harness vs. LLM: who does what

| Handled by the **harness** (deterministic) | Handled by the **LLM** (judgment) |
|--------------------------------------------|-----------------------------------|
| File reads/writes, artifact tracking | Clarifying the goal |
| Running tests / commands | Research & codebase understanding |
| Phase transitions & state | Planning & task decomposition |
| Retry & step budgets, stop conditions | Design decisions & trade‑offs |
| Provider health, routing, fallbacks | Analysis of failures & fixes |
| Command safety & sandbox boundaries | Audit / security / verification reasoning |
| Event routing to the UI | Choosing among valid strategies |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full technical breakdown.

---

## Architecture

```
+------------------------------------------+
|  Cockpit (VS Code webview)               |  React + TypeScript + Vite + Tailwind
|  chat · agent activity · approvals       |
+------------------------------------------+
                  │  postMessage IPC (EventBus events)
+------------------------------------------+
|  OmniOrchestrator                        |  drives the pipeline
|                                          |
|   Clarifier ─▶ Researcher ─▶ Planner ─▶  |
|   Coder(s) ─▶ Auditor ─▶ Security ─▶     |
|   Verifier ─▶ Deliver                    |
|                                          |
|   AgentRuntime (ReAct loop) · ToolRegistry
|   TaskCompass · ContextGovernor · Memory |
+------------------------------------------+
                  │
+----------------------------+   +-------------------------------+
|  ResilientModelRouter      |◀─▶|  Providers                    |
|  health · fallback ·       |   |  OpenRouter / Kilo Gateway /  |
|  budgeting · caching       |   |  Codik / Ollama / Offline     |
+----------------------------+   +-------------------------------+
                  │
+----------------------------+
|  Execution sandbox         |  Docker (dockerode) + @cline/sdk
|  CommandSafety block‑list  |  host fallback gated OFF by default
+----------------------------+
```

---

## Quick start

1. Install the extension in VS Code (build from source, or load a packaged `.vsix`).
2. Open the Command Palette and run **`Omni: Open Cockpit`**.
3. *(Optional)* Configure a provider: **`Omni: Configure API Keys`** (or Settings → Omni).
4. Type a goal, answer the clarifying questions, and launch the orchestration.

> **No API key?** OmniFlow still runs using its offline fallback engine — enough to explore the flow.

---

## LLM providers & routing

OmniFlow never hardcodes a single model. `ResilientModelRouter` selects a provider/model per call
based on the agent role, phase, budget, and live provider health, then falls back down a chain if a
provider is unavailable.

| Provider | Setting | Environment variable | Notes |
|----------|---------|----------------------|-------|
| OpenRouter | `omni.openrouterApiKey` | `OPENROUTER_API_KEY` | Free **and** paid models |
| Kilo Gateway | `omni.kiloGatewayApiKey` | `KILO_API_KEY` | Gateway routing |
| Codik | `omni.codikApiKey` | `CODIK_API_KEY` | Router |
| Ollama (local) | — | — | Runs models locally |
| Offline fallback | — | — | Rule‑based, no key required |

The model catalog is indexed at runtime (`ModelIndexer` → `ModelCapabilityRegistry`), including
paid models, with each model mapped to a price tier used by budget‑aware selection.

## Budget control

`omni.budget` maps to the model price tier the selector is allowed to reach:

| Budget | Price tier reached | Behavior |
|--------|--------------------|----------|
| `free` | free only | Never selects a paid model |
| `low` | cheap | Prefers the cheapest paid tier |
| `normal` | mid | Balanced |
| `high` | premium | Allows the strongest paid models |

If paid credits are exhausted at runtime, routing drops back to **free‑only** automatically.

---

## The agents

Agents live in `src/agents/` and share a common `BaseAgent` (event emission, LLM‑JSON review helpers).

| Agent | Role | Responsibility |
|-------|------|----------------|
| **Clarifier** | intake | Resolve ambiguity, capture intent, detect the user's language |
| **Researcher** | research | Gather context, explore the codebase and (optionally) the web |
| **Planner** | planning | Produce a build plan, stack, architecture, and success criteria |
| **Coder** | build | Implement artifacts via tools inside the sandbox |
| **Auditor** | audit | Review correctness & code quality (advisory) |
| **Security** | security | Scan for vulnerabilities & risky patterns |
| **Verifier** | verify | Validate artifacts against the success criteria |
| **Deliver** | deliver | Package outputs into the workspace and report |

Supporting agents include the **Chat**, **Context**, and **Self‑Prompting** agents; parallel coder
orchestration is available via `AgentSupervisor` (`omni.useSupervisor`).

---

## Memory system

`src/memory/` implements a layered memory facade (`MemoryFacade`) so weak models get *precise* context:

- **Working memory** — the current task and immediate context.
- **Episodic memory** — what happened in this and prior runs.
- **Semantic memory** — durable facts, decisions, and knowledge.
- **Procedural memory** — workflows and patterns.

`ContextGovernor` compacts message history to fit each model's context window, and `TaskCompass`
guards against goal drift over long runs.

## Code intelligence

`BuiltInCodeIndex` / `CodeIndex` build a symbol map of the workspace so an agent can jump straight to
the coordinates of a function or class (file, line) instead of re‑reading whole files — saving tokens
and keeping the context small and relevant. `SemanticEditor` applies symbol‑aware edits.

## Safety & the execution sandbox

- Tool commands run inside a **Docker sandbox** (`SandboxTool` + `@cline/sdk`) with an enforced boundary.
- When Docker is **unavailable**, autonomous host execution is **disabled by default**
  (`omni.allowLocalExecution = false`). You must explicitly opt in to run agent‑generated commands on
  your machine.
- `CommandSafety` maintains a block‑list of destructive commands (`rm -rf /`, `mkfs`, `dd`, `format`,
  `curl | sh`, `shutdown`, `git reset --hard`, …) that is **always** refused, even on the host path.
- File tools reject path traversal and absolute‑path escapes outside the workspace root.

## The Cockpit UI

The webview (`webview-ui/`) deliberately separates three channels so you always know what you're
looking at:

- **Reasoning** — the agent's internal thinking (collapsible; for those who want the detail).
- **Commentary** — short, plain‑language progress messages meant for you.
- **Delivery** — the final result and artifacts.

Events flow from the host to the UI over a typed `EventBus` (`REASONING_TRACE`, `AGENT_COMMENTARY`,
`TOOL_CALL`, `TOOL_RESULT`, `PHASE_TRANSITION`, `APPROVAL_REQUIRED`, …).

---

## Configuration reference

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `omni.openrouterApiKey` | string | `""` | OpenRouter API key (free + paid models) |
| `omni.kiloGatewayApiKey` | string | `""` | Kilo Gateway API key |
| `omni.codikApiKey` | string | `""` | Codik router API key |
| `omni.preferredProvider` | enum | `openrouter` | `openrouter` / `kilo-gateway` / `codik` / `ollama` / `fallback` |
| `omni.budget` | enum | `free` | Cost budget: `free` / `low` / `normal` / `high` |
| `omni.orchestratorModel` | string | `""` | Override model for the orchestrator role |
| `omni.toolApiKeys` | object | `{}` | Keys for external tools (e.g. `EXA_API_KEY`, `TAVILY_API_KEY`) |
| `omni.useSupervisor` | boolean | `false` | Parallel coder orchestration with retry/fallback via `AgentSupervisor` |
| `omni.llmSecurity` | boolean | `false` | LLM‑assisted security review on top of static scanning (advisory) |
| `omni.llmAudit` | boolean | `false` | LLM‑assisted code‑quality audit (advisory; soft `NEEDS_REVIEW` only) |
| `omni.allowLocalExecution` | boolean | `false` | Allow agent commands on the host when Docker is unavailable (destructive commands still refused) |

## Commands

| Command | Title |
|---------|-------|
| `omni.openCockpit` | Omni: Open Cockpit |
| `omni.start` | Omni: Start Orchestration |
| `omni.configureApi` | Omni: Configure API Keys |
| `omni.selectModel` | Omni: Select LLM Model |
| `omni.openArtifact` | Omni: Open Artifact |

---

## Development

Requires **Node ≥ 22** (matches CI).

```bash
npm install
npm run build           # compile the extension + build the webview
# press F5 in VS Code to launch the Extension Development Host
```

| Script | Purpose |
|--------|---------|
| `npm run compile` | Compile the extension (tsc → `dist/`) |
| `npm run webview:build` | Build the React Cockpit UI |
| `npm run lint` | Type‑check the whole project (`tsc --noEmit`) |
| `npm test` | Run the Vitest suite |
| `npm run package` | Package a `.vsix` (`vsce`) |

## Testing

```bash
npm test          # single run
npm run test:watch
```

The Vitest suite covers routing resilience (429 / 402 / 404, credits‑exhausted, Ollama recovery),
command safety, path‑traversal protection, budget‑tier selection, the code index, and more.

## Project layout

```
src/
  agents/     specialized agents (Clarifier, Researcher, Planner, Coder, Auditor, Security, Verifier, …)
  core/       orchestrator, ReAct runtime, routing/health, code index, prompts, policy, event bus
  routing/    provider‑agnostic LLM routing (router, selector, client, indexer, pricing tiers)
  memory/     layered memory (episodic / semantic / procedural / working) + facade
  shell/      sandbox tool, command safety, cross‑platform shell, semantic editor
  pipeline/   pipeline phases + per‑tier phase manifest
  config/     secret storage & settings
webview-ui/   React "Cockpit" (chat, agent activity, approvals)
shared/       types shared between host and webview
plans/        model indices & architectural notes
```

## Status & roadmap

OmniFlow is an active, evolving project. Current focus areas:

- **Reliability first** — never emit empty/fabricated files or silently fall back; surface provider
  failures explicitly and in the user's language.
- **One global loop/budget controller** with clear stop conditions.
- **End‑to‑end language propagation** across all phases.
- **Sharper Cockpit separation** of reasoning / commentary / delivery.
- **Progressive skills/MCP** loaded on demand by task, rather than stuffed into every prompt.

## License

Released under the [MIT License](LICENSE).
