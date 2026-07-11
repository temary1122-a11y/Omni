/**
 * ToolManager
 * 
 * Manages dynamic tool installation and usage for agents
 * Agents can request tools to be installed and use them in their workflows
 */

import { EventBus } from './EventBus';
import { SandboxTool } from '../shell/SandboxTool';
import * as fs from 'fs';
import * as path from 'path';

export interface ToolDefinition {
  name: string;
  description: string;
  category: 'scraping' | 'search' | 'analysis' | 'utility' | 'ai';
  npmPackage?: string;
  pipPackage?: string;
  installCommand?: string;
  version?: string;
  requiredFor?: string[]; // Agent roles that need this tool
  apiKeyEnv?: string;   // Env var that holds this tool's API key, e.g. 'EXA_API_KEY'
  signupUrl?: string;   // URL where the user can create the API key
}

export interface ToolInstallationResult {
  success: boolean;
  toolName: string;
  output?: string;
  error?: string;
}

export class ToolManager {
  private installedTools: Set<string> = new Set();
  private availableTools: Map<string, ToolDefinition> = new Map();
  private eventBus: EventBus;
  private sandbox: SandboxTool;
  private workspaceRoot: string;
  private readonly cachePath: string;

  constructor(eventBus: EventBus, sandbox: SandboxTool, workspaceRoot: string) {
    this.eventBus = eventBus;
    this.sandbox = sandbox;
    this.workspaceRoot = workspaceRoot;
    this.cachePath = path.join(workspaceRoot, '.omniflow', 'installed-tools.json');
    this.initializeAvailableTools();
    this.loadCache();
  }

  /**
   * Initialize available tools registry
   */
  private initializeAvailableTools(): void {
    // Scraping tools
    this.registerTool({
      name: 'puppeteer',
      description: 'Headless Chrome/Chromium browser automation for web scraping',
      category: 'scraping',
      npmPackage: 'puppeteer',
      version: '^21.0.0',
      requiredFor: ['coder', 'researcher'],
    });

    this.registerTool({
      name: 'playwright',
      description: 'Cross-browser automation for web scraping and testing',
      category: 'scraping',
      npmPackage: 'playwright',
      version: '^1.40.0',
      requiredFor: ['coder', 'researcher'],
    });

    this.registerTool({
      name: 'cheerio',
      description: 'Fast HTML parsing for web scraping',
      category: 'scraping',
      npmPackage: 'cheerio',
      version: '^1.0.0-rc.12',
      requiredFor: ['coder', 'researcher'],
    });

    this.registerTool({
      name: 'axios',
      description: 'HTTP client for making requests',
      category: 'utility',
      npmPackage: 'axios',
      version: '^1.6.0',
      requiredFor: ['coder', 'researcher'],
    });

    // Search tools
    this.registerTool({
      name: 'exa',
      description: 'AI-powered search API for web research',
      category: 'search',
      npmPackage: 'exa-js',
      version: '^1.0.0',
      requiredFor: ['researcher'],
      apiKeyEnv: 'EXA_API_KEY',
      signupUrl: 'https://dashboard.exa.ai/api-keys',
    });

    this.registerTool({
      name: 'tavily',
      description: 'AI search API for comprehensive web research',
      category: 'search',
      npmPackage: '@tavily/core',
      apiKeyEnv: 'TAVILY_API_KEY',
      signupUrl: 'https://app.tavily.com/keys',
    });

    // Analysis tools
    this.registerTool({
      name: 'natural',
      description: 'Natural language processing library',
      category: 'analysis',
      npmPackage: 'natural',
      version: '^6.0.0',
      requiredFor: ['researcher', 'coder'],
    });

    // AI tools
    this.registerTool({
      name: 'openai',
      description: 'OpenAI API client',
      category: 'ai',
      npmPackage: 'openai',
      version: '^4.0.0',
      requiredFor: ['coder', 'researcher'],
    });
  }

  /**
   * Register a tool definition
   */
  registerTool(tool: ToolDefinition): void {
    this.availableTools.set(tool.name, tool);
  }

  /**
   * Get tool definition
   */
  getTool(name: string): ToolDefinition | undefined {
    return this.availableTools.get(name);
  }

  /**
   * Get all available tools
   */
  getAvailableTools(): ToolDefinition[] {
    return Array.from(this.availableTools.values());
  }

  /**
   * Get tools by category
   */
  getToolsByCategory(category: ToolDefinition['category']): ToolDefinition[] {
    return Array.from(this.availableTools.values()).filter(t => t.category === category);
  }

  /**
   * Get tools required for a specific agent role
   */
  getToolsForAgent(agentRole: string): ToolDefinition[] {
    return Array.from(this.availableTools.values()).filter(t => 
      t.requiredFor?.includes(agentRole)
    );
  }

  /**
   * Check if a tool is installed
   */
  isToolInstalled(toolName: string): boolean {
    return this.installedTools.has(toolName);
  }

  /**
   * Install a tool dynamically
   */
  async installTool(toolName: string): Promise<ToolInstallationResult> {
    const tool = this.availableTools.get(toolName);
    
    if (!tool) {
      return {
        success: false,
        toolName,
        error: `Tool ${toolName} not found in registry`,
      };
    }

    if (this.installedTools.has(toolName)) {
      return {
        success: true,
        toolName,
        output: `Tool ${toolName} already installed`,
      };
    }

    this.eventBus.emit({
      type: 'AGENT_COMMENTARY',
      payload: {
        agentId: 'tool-manager',
        phase: 'build',
        message: `Installing tool: ${toolName}`,
        timestamp: Date.now(),
      } as any,
    });

    try {
      let command: string;
      
      if (tool.npmPackage) {
        command = `npm install ${tool.npmPackage}${tool.version ? `@${tool.version}` : ''}`;
      } else if (tool.pipPackage) {
        command = `pip install ${tool.pipPackage}${tool.version ? `==${tool.version}` : ''}`;
      } else if (tool.installCommand) {
        command = tool.installCommand;
      } else {
        return {
          success: false,
          toolName,
          error: `No installation method defined for tool ${toolName}`,
        };
      }

      const result = await this.sandbox.executeInSandbox({
        command,
        cwd: this.workspaceRoot,
      });

      if (result.exitCode === 0) {
        this.installedTools.add(toolName);
        
        this.eventBus.emit({
          type: 'AGENT_COMMENTARY',
          payload: {
            agentId: 'tool-manager',
            phase: 'build',
            message: `Successfully installed ${toolName}`,
            timestamp: Date.now(),
          } as any,
        });

        return {
          success: true,
          toolName,
          output: result.stdout || result.stderr,
        };
      } else {
        return {
          success: false,
          toolName,
          error: result.stderr || result.stdout || `Installation failed with exit code ${result.exitCode}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Install multiple tools
   */
  async installTools(toolNames: string[]): Promise<ToolInstallationResult[]> {
    const results: ToolInstallationResult[] = [];
    
    for (const toolName of toolNames) {
      const result = await this.installTool(toolName);
      results.push(result);
      
      // If installation fails, continue with next tool
      if (!result.success) {
        console.error(`Failed to install ${toolName}: ${result.error}`);
      }
    }
    
    return results;
  }

  /**
   * Auto-install tools based on task requirements
   */
  async autoInstallToolsForTask(
    agentRole: string,
    taskDescription: string
  ): Promise<ToolInstallationResult[]> {
    // Get tools required for this agent
    const requiredTools = this.getToolsForAgent(agentRole);
    
    // Analyze task description for tool hints
    const taskLower = taskDescription.toLowerCase();
    const suggestedTools: string[] = [];
    
    if (taskLower.includes('scrap') || taskLower.includes('parse') || taskLower.includes('crawl')) {
      suggestedTools.push('puppeteer', 'cheerio', 'axios');
    }
    
    if (taskLower.includes('search') || taskLower.includes('research')) {
      suggestedTools.push('exa', 'tavily');
    }
    
    if (taskLower.includes('nlp') || taskLower.includes('text analysis')) {
      suggestedTools.push('natural');
    }
    
    // Combine required and suggested tools
    const toolsToInstall = new Set([
      ...requiredTools.map(t => t.name),
      ...suggestedTools,
    ]);
    
    return this.installTools(Array.from(toolsToInstall));
  }

  /**
   * Get installation status for all tools
   */
  getInstallationStatus(): Record<string, boolean> {
    const status: Record<string, boolean> = {};
    
    for (const toolName of this.availableTools.keys()) {
      status[toolName] = this.installedTools.has(toolName);
    }
    
    return status;
  }

  /**
   * Load installed tools cache from disk
   */
  private loadCache(): void {
    try {
      if (fs.existsSync(this.cachePath)) {
        const data = JSON.parse(fs.readFileSync(this.cachePath, 'utf-8'));
        if (Array.isArray(data.installedTools)) {
          this.installedTools = new Set(data.installedTools);
        }
      }
    } catch {
      // Cache file corrupted or unreadable; start fresh
      this.installedTools = new Set();
    }
  }

  /**
   * Save installed tools cache to disk
   */
  private saveCache(): void {
    try {
      const dir = path.dirname(this.cachePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.cachePath, JSON.stringify({ installedTools: Array.from(this.installedTools) }, null, 2));
    } catch {
      // Ignore cache write errors
    }
  }

  /**
   * Clear installed tools cache (for testing or reinstallation)
   */
  clearInstalledCache(): void {
    this.installedTools.clear();
  }
}

