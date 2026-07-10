# OmniFlow

![CI](https://github.com/temary1122-a11y/OmniFlow/actions/workflows/ci.yml/badge.svg)

> AI Agent Orchestrator for VS Code — turn a plain-language goal into a working MVP.

OmniFlow is a VS Code extension that acts as an autonomous software-delivery orchestrator. You describe what you want to build in natural language; OmniFlow clarifies the goal, then drives a multi-agent pipeline (Research → Planning → Build → Audit → Security → Verification) that designs, implements, and delivers the project directly inside your workspace.

It is provider-agnostic: it routes prompts to OpenRouter (free models), Kilo Gateway, Codik, or a local Ollama instance, and falls back to an offline rule-based engine when no API key is configured — so it runs out of the box.

## Features

- **Goal clarification** — asks clarifying questions before writing any code.
- **Multi-agent pipeline** — an Orchestrator coordinates specialized agents through the full delivery lifecycle.
- **Provider-agnostic LLM routing** — OpenRouter, Kilo Gateway, Codik, Ollama, with an offline fallback.
- **Budget control** — `free` / `low` / `normal` / `high` cost tiers select appropriate models.
- **Sandboxed execution** — tool calls run inside a boundary-enforced sandbox.
- **Code intelligence** — built-in code indexing and symbol-aware (semantic) editing.
- **Interactive Cockpit** — a React webview with live chat and an agent execution graph.
- **Zero-config start** — no API key required to try (offline fallback).

## Architecture

```
+----------------------------------+
|  Cockpit (VS Code webview)       |  React + TypeScript
+----------------------------------+
                  | IPC
+----------------------------------+
|  OmniOrchestrator                |
|                                  |
|   Clarifier -> Researcher ->     |
|   Planner -> Coder(s) ->         |
|   Auditor -> Security ->         |
|   Verifier -> Deliver            |
+----------------------------------+
                  | 
+----------------------------------+      +------------------------------+
|  ResilientModelRouter            |<---->|  Providers                   |
|  (health, fallback, budgeting,   |      |  OpenRouter / Kilo Gateway   |
|   caching)                       |      |  / Codik / Ollama / Offline  |
+----------------------------------+      +------------------------------+
```

## Quick Start

1. Install the extension in VS Code (build from source or load the `.vsix`).
2. Open the Command Palette and run **`OmniFlow: Open Cockpit`**.
3. *(Optional)* Configure providers: **`OmniFlow: Configure API Keys`** (or Settings -> OmniFlow).
4. Type a goal, answer the clarifying questions, and click **Launch Orchestration**.

> No API key? OmniFlow still runs using its offline fallback engine.

## LLM Providers

| Provider | Setting | Environment variable |
|----------|---------|----------------------|
| OpenRouter (free models) | `omni.openrouterApiKey` | `OPENROUTER_API_KEY` |
| Kilo Gateway | `omni.kiloGatewayApiKey` | `KILO_API_KEY` |
| Codik | `omni.codikApiKey` | `CODIK_API_KEY` |
| Ollama (local) | - | - |

Configure via **OmniFlow: Configure API Keys** or VS Code Settings -> OmniFlow.

## Agent Pipeline

| Phase | Agent | Responsibility |
|-------|-------|----------------|
| Intake | Clarifier | Resolve ambiguity, capture intent |
| Research | Researcher | Gather context, explore the codebase |
| Planning | Planner | Produce a build plan & success criteria |
| Build | Coder(s) | Implement artifacts in the sandbox |
| Audit | Auditor | Review correctness & quality |
| Security | Security | Scan for vulnerabilities & risks |
| Verify | Verifier | Validate against success criteria |
| Deliver | Deliver | Package outputs into the workspace |

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `omni.preferredProvider` | enum | `openrouter` | LLM provider to use |
| `omni.budget` | enum | `free` | Cost budget (`free`/`low`/`normal`/`high`) |
| `omni.orchestratorModel` | string | - | Override model for the orchestrator role |
| `omni.useSupervisor` | boolean | `false` | Parallel coder orchestration via AgentSupervisor |
| `omni.toolApiKeys` | object | `{}` | Keys for external tools (e.g. EXA, Tavily) |

## Development

```bash
npm install
npm run build
# Press F5 to launch the Extension Development Host
```

| Script | Purpose |
|--------|---------|
| `npm run compile` | Compile the extension (tsc) |
| `npm run webview:build` | Build the React Cockpit UI |
| `npm test` | Run the Vitest suite |

## License

Released under the [MIT License](LICENSE).
