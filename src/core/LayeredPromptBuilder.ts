export interface PromptLayer {
  name: string;
  content: string;
  priority: number;
  condition?: (context: any) => boolean;
}

function detectLanguage(text: string): string {
  if (/[а-яА-ЯёЁ]/.test(text)) return 'Russian';
  if (/[\u4e00-\u9fff]/.test(text)) return 'Chinese';
  if (/[\u0600-\u06FF]/.test(text)) return 'Arabic';
  return 'English';
}

export interface PromptContext {
  agentId: string;
  phase: string;
  goal: string;
  workspaceSnapshot?: any;
  researchSummary?: string;
  planSummary?: string;
  userDecisions?: Record<string, string>;
  /** TaskCompass context block (TRUE GOAL) to anchor the agent. */
  compassContextBlock?: string;
  [key: string]: any;
}

export class LayeredPromptBuilder {
  private layers: PromptLayer[] = [];

  addLayer(layer: PromptLayer): void {
    this.layers.push(layer);
    this.layers.sort((a, b) => b.priority - a.priority);
  }

  build(context: PromptContext): string {
    const activeLayers = this.layers.filter(layer => {
      if (layer.condition) {
        return layer.condition(context);
      }
      return true;
    });

    return activeLayers.map(layer => layer.content).join('\n\n');
  }

  buildSystemPrompt(context: PromptContext): string {
    const basePrompt = this.build(context);
    const anchored = context.compassContextBlock
      ? `${context.compassContextBlock}\n\n${basePrompt}`
      : basePrompt;
    const language = detectLanguage(context.goal);
    const languageDirective =
      language === 'English'
        ? ''
        : `\n\nIMPORTANT: Respond in ${language} to match the user's language.`;
    return `${anchored}\n\nCurrent task: ${context.goal}${languageDirective}`;
  }

  buildUserPrompt(context: PromptContext): string {
    let prompt = '';

    if (context.workspaceSnapshot) {
      prompt += `Workspace: ${context.workspaceSnapshot.fileTree.join(', ')}\n`;
    }

    if (context.researchSummary) {
      prompt += `\nResearch: ${context.researchSummary}\n`;
    }

    if (context.planSummary) {
      prompt += `\nPlan: ${context.planSummary}\n`;
    }

    if (context.userDecisions && Object.keys(context.userDecisions).length > 0) {
      prompt += `\nUser decisions:\n`;
      for (const [key, value] of Object.entries(context.userDecisions)) {
        prompt += `- ${key}: ${value}\n`;
      }
    }

    return prompt;
  }

  /** Merge layered base prompt with role-specific instructions. */
  composeSystemPrompt(roleExtension: string, context: PromptContext): string {
    const layered = this.build(context);
    const anchored = context.compassContextBlock
      ? `${context.compassContextBlock}\n\n${layered}`
      : layered;
    return `${anchored}\n\n${roleExtension}`;
  }

  removeLayer(name: string): void {
    this.layers = this.layers.filter(l => l.name !== name);
  }

  clear(): void {
    this.layers = [];
  }

  getLayers(): PromptLayer[] {
    return [...this.layers];
  }
}

export function createDefaultPromptBuilder(): LayeredPromptBuilder {
  const builder = new LayeredPromptBuilder();

  // Base layer - always included
  builder.addLayer({
    name: 'base',
    content: `You are an AI coding assistant working in a VS Code environment.
You have access to tools for reading files, writing files, executing commands, and making semantic code edits.
Always think step by step and use tools to accomplish tasks.`,
    priority: 100,
  });

  // Safety layer - always included
  builder.addLayer({
    name: 'safety',
    content: `Safety rules:
- Never expose secrets, API keys, or credentials
- Always verify changes by reading files back
- Use semantic edits (replace_symbol) when modifying existing code
- Create backups before destructive operations
- Report errors clearly with context`,
    priority: 90,
  });

  // Tool usage layer - always included
  builder.addLayer({
    name: 'tools',
    content: `Tool usage:
- Use read_file to examine existing code
- Use write_file to create new files
- Use replace_symbol for precise edits to existing symbols
- Use bash to run tests, builds, and linters
- Always check tool results before proceeding`,
    priority: 80,
  });

  // Phase-specific layers
  builder.addLayer({
    name: 'planning',
    content: `Planning mode:
- Analyze the goal and break it into subtasks
- Consider dependencies and execution order
- Output a structured plan with file paths and descriptions`,
    priority: 70,
    condition: (ctx) => ctx.phase === 'planning',
  });

  builder.addLayer({
    name: 'building',
    content: `Building mode:
- Generate production-ready code
- Follow existing code style and patterns
- Write tests if applicable
- Ensure all imports and dependencies are correct`,
    priority: 70,
    condition: (ctx) => ctx.phase === 'build',
  });

  builder.addLayer({
    name: 'verification',
    content: `Verification mode:
- Run tests and linters
- Check for syntax errors
- Verify all requirements are met
- Report any issues found`,
    priority: 70,
    condition: (ctx) => ctx.phase === 'verify',
  });

  return builder;
}
