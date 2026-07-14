# OmniFlow architecture

This document is the technical companion to the [README](./README.md). It explains how a natural‑language
goal becomes a delivered project, and how the major subsystems fit together.

- [Design principles](#design-principles)
- [The request lifecycle](#the-request-lifecycle)
- [Orchestration](#orchestration)
- [The agent runtime (ReAct loop)](#the-agent-runtime-react-loop)
- [Agents](#agents)
- [Model routing](#model-routing)
- [Memory](#memory)
- [Code intelligence](#code-intelligence)
- [Tools & the execution sandbox](#tools--the-execution-sandbox)
- [Events & the Cockpit](#events--the-cockpit)
- [Extension host](#extension-host)
- [Module map](#module-map)

---

## Design principles

OmniFlow follows the "effective agents" philosophy: keep the LLM for judgment, keep everything else
deterministic. Concretely:

1. **LLM only where judgment is required.** Planning, decomposition, research, design choices,
   failure analysis, and review use the model. File I/O, test execution, state transitions,
   retry/step budgets, provider health, command safety, and event routing are pure harness code.
2. **Ground truth from the environment.** An artifact is real only after a tool call succeeds; a
   check passes only after it actually runs. The harness does not trust "I created the file" in the
   model's prose.
3. **Earned complexity.** The orchestrator scales the pipeline to the task (LOW / MEDIUM / HIGH),
   rather than always running the full eight‑phase script.
4. **Transparency.** The agent's reasoning, its user‑facing commentary, and the final delivery are
   distinct event channels, so the UI can show the right thing in the right place.

---

## The request lifecycle

```
User goal (natural language)
      │
      ▼
[intake] Clarifier ── detects language, asks clarifying questions, sets complexity
      │
      ▼
RoleSelector.select(goal, complexity)  ── picks agents → phases → tier
      │
      ▼
phasesToRun = [intake] + selected phases (+ self-prompt if HIGH) + [deliver]
      │
      ▼
for each phase:  PhaseEngine runs the phase's agent(s) through AgentRuntime
      │              │
      │              ├─ ToolRegistry executes tool calls (sandboxed)
      │              ├─ ResilientModelRouter serves LLM calls
      │              ├─ Memory + ContextGovernor manage context
      │              └─ TaskCompass guards against drift
      ▼
[deliver] artifacts packaged into the workspace + DeliveryReport
```

Intake runs first and is special: complexity is not known until the goal is understood, so the
orchestrator starts with `phases: ['intake']` and only then computes the full phase list.

---

## Orchestration

`src/core/OmniOrchestrator.ts` is the conductor. After intake it:

1. Reads the resolved `goalPacket` (goal + complexity + workspace snapshot).
2. Calls `RoleSelector` to get the tier, the ordered agent roles, the phases, and whether to run
   the self‑prompting convergence loop.
3. Assembles `phasesToRun` (always `intake` first, `deliver` last), then executes each phase in
   order via the pipeline `PhaseEngine`.
4. Emits events (phase transitions, approvals, artifacts, delivery) on the `EventBus`.

Supporting pieces:

- **`RoleSelector`** (`src/core/RoleSelector.ts`) — replaces the old hardcoded `switch (complexity)`.
  Maps complexity + goal signals (security / audit / planning keywords) to roles, then roles to
  phases via `ROLE_TO_PHASE`. HIGH runs every agent plus self‑prompting.
- **`pipelineManifest.ts`** (`src/pipeline/`) — declares the canonical phase set per tier
  (`TIER_PHASE_MANIFEST`) and `tierIncludesPhase()`.
- **`OrchestrationPolicy`** (`src/core/OrchestrationPolicy.ts`) — a small rules engine deciding
  parallel vs. sequential build, retry, and fallback based on pending contracts, failures, and
  budget. Rules are priority‑ordered and pluggable (`addRule` / `removeRule`).
- **`AgentSupervisor`** (`src/core/AgentSupervisor.ts`) — optional parallel coder orchestration with
  retry/backoff (enabled by `omni.useSupervisor`).
- **`HandoffContract`** — the typed task spec passed between phases (goal packet, boundary,
  dependencies, context packet, subtask id).

---

## The agent runtime (ReAct loop)

`src/core/AgentRuntime.ts` runs a single agent as a **Reason → Act** loop: the model proposes a
thought and optional tool calls; the harness executes tools and feeds results back; repeat until the
agent produces a final answer or a stop condition fires.

Key options (`AgentRuntimeOptions`): `agentId`, `tools`, `maxIterations`, `systemPrompt`,
`workspaceRoot`, `boundary`, `memory`, callbacks (`onReasoning`, `onToolCall`, `onToolResult`,
`onIteration`), `taskCompass`, `driftThreshold`, `contextLimit`.

**Stop conditions / loop guards** (deliberately explicit — an agent must be able to stop):

- `maxIterations` — hard cap on loop turns.
- Repeated‑action detection — identical tool + args three times in a row stops the run
  (`write_file` compares a content fingerprint, not the full content).
- Similar‑call detection — repeated calls to the same tool with near‑identical args stop the run.
- Consecutive shell‑failure and goal‑drift tracking (`TaskCompass` + `driftThreshold`) request a
  redirect or stop.
- `onIteration` hook lets the orchestrator inject a system note or request a stop.

**Artifacts** are collected only from *successful* write tool results — the runtime records what the
tools actually wrote, which is what `deliver` packages.

`AgentRuntime` also owns per‑call context assembly with `ContextGovernor` (compaction to the model's
window) and memory retrieval.

---

## Agents

All agents extend `BaseAgent` (`src/agents/BaseAgent.ts`), which provides:

- `emitReasoning(phase, thought)` → `REASONING_TRACE` events (internal thinking).
- `emitCommentary(phase, message)` → `AGENT_COMMENTARY` events (plain‑language, user‑facing).
- `callLlmJsonReview(...)` → an advisory LLM‑JSON helper that returns `null` on fallback/parse
  failure (used by audit/security so a degraded provider never turns into a hard failure).

Roles and responsibilities are listed in the [README](./README.md#the-agents). The Clarifier detects
the user's language at intake; propagating that language across *all* phases is an active
reliability goal.

---

## Model routing

The routing stack (`src/routing/` + `src/core/ResilientModelRouter.ts`) is fully provider‑agnostic —
no single model is hardcoded.

```
call(role, phase, budget, prompt)
      │
      ▼
ModelSelector ── picks a model from the registry for the role/phase within the budget's price tier
      │
      ▼
ResilientModelRouter ── health checks, ordered fallback chain, caching, telemetry
      │
      ▼
LLMClient ── provider HTTP (OpenRouter / Kilo Gateway / Codik / Ollama) or offline engine
```

- **`ModelIndexer`** refreshes the live catalog into **`ModelCapabilityRegistry`** (context window,
  price, role suitability). Paid models are indexed too.
- **`pricingTiers.ts`** classifies each model into free / cheap / mid / premium; `omni.budget` maps
  to the highest tier the selector may reach. Unknown pricing is treated conservatively as premium.
- **`RouterHealthMonitor`** tracks provider status (429 / 402 / 404, credits exhausted) and steers
  the fallback chain; credits‑exhausted forces free‑only.
- **`ResultCache`** deduplicates identical calls.

Fallback semantics are a known reliability focus: a provider failure should surface as an explicit,
visible error (in the user's language), not a silent stub.

---

## Memory

`src/memory/` implements a layered store behind `MemoryFacade`:

| Layer | File | Holds |
|-------|------|-------|
| Working | `WorkingMemory.ts` | Current task & immediate context |
| Episodic | `EpisodicMemory.ts` | Events from this and prior runs |
| Semantic | `SemanticMemory.ts` | Durable facts, decisions, knowledge |
| Procedural | `ProceduralMemory.ts` | Workflows & patterns |

`HierarchicalMemory` and `LedgerMemory` compose these; `vectorUtils.ts` supports similarity
retrieval. The aim is *precise* recall (small, relevant context that helps weaker models), not
merely more text.

`ContextGovernor` (`src/core/`) compacts conversation history to fit each model's context window;
`TaskCompass` keeps long runs aligned with the original goal.

---

## Code intelligence

`BuiltInCodeIndex` / `CodeIndex` (`src/core/`) build a symbol map of the workspace:

- `findSymbol(name)` → the coordinates (file, line, kind) of a function/class, so an agent reads
  *only* the relevant span instead of the whole file.
- `findDependencies(file)` → imports/requires/exports resolution.
- `semanticSearch(query)` → scored, language‑filtered search across the index.

`SemanticEditor` (`src/shell/`) applies symbol‑aware edits and emits `SYMBOL_RESOLVED` /
`SEMANTIC_EDIT_APPLIED` events. Coordinate‑based access is the main lever for keeping token usage low.

---

## Tools & the execution sandbox

Tools are registered in `ToolRegistry` (`src/core/`) and exposed to the runtime with schemas. File
tools resolve caller paths through `resolveWithinWorkspace`, which rejects absolute paths and `..`
escapes (no sibling‑prefix false positives).

Execution:

- **`SandboxTool`** (`src/shell/`) runs commands in a Docker container (`dockerode` + `@cline/sdk`)
  with an enforced boundary.
- When Docker is unavailable, `omni.allowLocalExecution` (default **false**) gates host execution.
  Even when enabled, **`CommandSafety`** (`src/shell/CommandSafety.ts`) refuses a block‑list of
  destructive commands on every entry point, including the static host‑fallback path.
- **`CrossPlatformShell`** abstracts shell differences across OSes.

`ExecutionRouter` chooses between the cline SDK backend and the legacy backend, falling back to
legacy on configuration or runtime errors.

---

## Events & the Cockpit

The host communicates with the webview over a typed `EventBus` (`src/core/EventBus.ts`); event shapes
live in `shared/types`. Notable events:

| Event | Meaning |
|-------|---------|
| `REASONING_TRACE` | Agent internal thinking (Cockpit "reasoning" channel) |
| `AGENT_COMMENTARY` | Plain‑language progress for the user |
| `TOOL_CALL` / `TOOL_RESULT` | Tool invocation and outcome |
| `PHASE_TRANSITION` | Pipeline moved between phases |
| `ARTIFACT_CREATED` | A file artifact was produced |
| `VERIFICATION_RESULT` | PASS / FAIL / NEEDS_REVIEW verdict |
| `APPROVAL_REQUIRED` / `APPROVAL_RESPONSE` | Human‑in‑the‑loop gate |
| `LLM_CALL` / `PROVIDER_STATUS` | Routing telemetry |
| `ERROR_OCCURRED` | Recoverable / non‑recoverable error |
| `DELIVERY_COMPLETE` | Final report |

The Cockpit (`webview-ui/`, React + Vite + Tailwind) renders these into three distinct surfaces —
**reasoning**, **commentary**, and **delivery** — so users are never confused about whether they're
reading the agent's private thoughts or a message addressed to them. The store
(`webview-ui/src/store/omniStore.ts`) routes each event to the correct surface with density/verbosity
filters.

---

## Extension host

`src/extension.ts` is the VS Code entry point. It registers commands (`omni.openCockpit`,
`omni.start`, `omni.configureApi`, `omni.selectModel`, `omni.openArtifact`), wires the Cockpit
webview view (`omni.cockpit`), and constructs the orchestrator and routing stack. Secrets/settings
are managed via `src/config/ConfigManager.ts` (VS Code `SecretStorage` for prompted keys; settings
for the rest).

---

## Module map

```
src/
  extension.ts            VS Code activation, command + webview wiring
  agents/                 BaseAgent + specialized agents
  core/
    OmniOrchestrator.ts   pipeline conductor
    RoleSelector.ts       complexity/goal → roles → phases
    OrchestrationPolicy.ts parallel/sequential/retry/fallback rules
    AgentRuntime.ts       ReAct loop + stop conditions + artifact capture
    AgentSupervisor.ts    optional parallel coder orchestration
    ResilientModelRouter.ts health/fallback/budget/caching
    ToolRegistry.ts       tool schemas + path containment
    ExecutionRouter.ts    cline vs. legacy backend selection
    BuiltInCodeIndex.ts / CodeIndex.ts  symbol index
    ContextGovernor.ts    context‑window compaction
    TaskCompass.ts        goal‑drift guard
    EventBus.ts           typed host→webview events
  routing/                ModelSelector, ModelIndexer, ModelCapabilityRegistry,
                          LLMClient, pricingTiers, providerUtils, RequestClassifier
  memory/                 working / episodic / semantic / procedural + facade
  shell/                  SandboxTool, CommandSafety, CrossPlatformShell, SemanticEditor
  pipeline/               phases + pipelineManifest (per‑tier phase sets)
  config/                 ConfigManager (secrets + settings)
webview-ui/               React Cockpit (chat, agent activity, approvals)
shared/                   types shared between host and webview
plans/                    model indices & notes
```
