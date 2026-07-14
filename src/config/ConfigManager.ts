import * as vscode from 'vscode';
import type { Provider } from '../routing/ModelRouter';
import type { AgentRole } from '../../shared/types';

export interface OmniConfig {
  openrouterApiKey: string;
  kiloGatewayApiKey: string;
  codikApiKey: string;
  toolApiKeys: Record<string, string>;
  preferredProvider: Provider;
  budget: 'free' | 'low' | 'normal' | 'high';
  orchestratorModel: string;
  roleModels: Partial<Record<AgentRole, string>>;
  useSupervisor: boolean;
  /** When true, the AuditAgent may call an LLM for advisory code-quality review (default false). */
  llmAudit: boolean;
  /** When true, the SecurityAgent may call an LLM for contextual security review (default false). */
  llmSecurity: boolean;
  /**
   * When true, agent-generated commands may run directly on the host if the Docker
   * sandbox is unavailable (no isolation). Default false — host execution is refused
   * without a container unless the user explicitly opts in.
   */
  allowLocalExecution: boolean;
}

export class ConfigManager {
  private static secretStorage: vscode.SecretStorage | null = null;
  private static secretCache: Record<string, string> = {};

  static initSecretStorage(secrets: vscode.SecretStorage): void {
    ConfigManager.secretStorage = secrets;
  }

  static async preloadSecrets(): Promise<void> {
    if (!ConfigManager.secretStorage) return;
    const keys = ['openrouterApiKey', 'kiloGatewayApiKey', 'codikApiKey'] as const;
    for (const key of keys) {
      const val = await ConfigManager.secretStorage.get(`omni.${key}`);
      if (val) ConfigManager.secretCache[key] = val;
    }
  }

  private static getCachedSecret(key: string): string | undefined {
    return ConfigManager.secretCache[key];
  }

  static load(): OmniConfig {
    const cfg = vscode.workspace.getConfiguration('omni');
    const getKey = (settingKey: string, cacheKey: string, envVar?: string) => {
      const cached = ConfigManager.getCachedSecret(cacheKey);
      if (cached) return cached;
      return (cfg.get<string>(settingKey, '') || (envVar ? process.env[envVar] : '') || '') as string;
    };
    return {
      openrouterApiKey: getKey('openrouterApiKey', 'openrouterApiKey', 'OPENROUTER_API_KEY'),
      kiloGatewayApiKey: getKey('kiloGatewayApiKey', 'kiloGatewayApiKey', 'KILO_API_KEY'),
      codikApiKey: getKey('codikApiKey', 'codikApiKey', 'CODIK_API_KEY'),
      toolApiKeys: cfg.get<Record<string, string>>('toolApiKeys', {}) || {},
      preferredProvider: cfg.get<Provider>('preferredProvider', 'openrouter'),
      budget: cfg.get('budget', 'free'),
      orchestratorModel: cfg.get<string>('orchestratorModel', '') || '',
      roleModels: cfg.get<Partial<Record<AgentRole, string>>>('roleModels', {}) || {},
      useSupervisor: cfg.get<boolean>('useSupervisor', false),
      llmAudit: cfg.get<boolean>('llmAudit', false),
      llmSecurity: cfg.get<boolean>('llmSecurity', false),
      allowLocalExecution: cfg.get<boolean>('allowLocalExecution', false),
    };
  }

  static toApiKeys(config: OmniConfig): Record<string, string> {
    return {
      ...config.toolApiKeys,
      openrouter: config.openrouterApiKey,
      'kilo-gateway': config.kiloGatewayApiKey,
      codik: config.codikApiKey,
      ollama: '', // local, no key
    };
  }

  static async setToolApiKey(envVar: string, value: string): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('omni');
    const current = cfg.get<Record<string, string>>('toolApiKeys', {}) || {};
    current[envVar] = value;
    await cfg.update('toolApiKeys', current, vscode.ConfigurationTarget.Global);
  }

  static getRoleModels(): Partial<Record<AgentRole, string>> {
    const cfg = vscode.workspace.getConfiguration('omni');
    return cfg.get<Partial<Record<AgentRole, string>>>('roleModels', {}) || {};
  }

  static async setRoleModels(map: Partial<Record<AgentRole, string>>): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration('omni');
      await cfg.update('roleModels', map, vscode.ConfigurationTarget.Global);
    } catch (error: any) {
      const message = error?.message || String(error);
      if (message.includes('EPERM') || message.includes('operation not permitted')) {
        throw new Error(
          'Cannot save settings: VS Code lacks permission to write settings.json. ' +
          'Solutions: 1) Run VS Code as Administrator, 2) Check if settings.json is read-only, ' +
          '3) Close other VS Code instances, 4) Check antivirus/security software blocking.'
        );
      }
      throw error;
    }
  }

  static async updateSettings(partial: {
    budget?: OmniConfig['budget'];
    preferredProvider?: Provider;
    useSupervisor?: boolean;
  }): Promise<void> {
    try {
      const cfg = vscode.workspace.getConfiguration('omni');
      if (partial.budget !== undefined) {
        await cfg.update('budget', partial.budget, vscode.ConfigurationTarget.Global);
      }
      if (partial.preferredProvider !== undefined) {
        await cfg.update('preferredProvider', partial.preferredProvider, vscode.ConfigurationTarget.Global);
      }
      if (partial.useSupervisor !== undefined) {
        await cfg.update('useSupervisor', partial.useSupervisor, vscode.ConfigurationTarget.Global);
      }
    } catch (error: any) {
      const message = error?.message || String(error);
      if (message.includes('EPERM') || message.includes('operation not permitted')) {
        throw new Error(
          'Cannot save settings: VS Code lacks permission to write settings.json. ' +
          'Solutions: 1) Run VS Code as Administrator, 2) Check if settings.json is read-only, ' +
          '3) Close other VS Code instances, 4) Check antivirus/security software blocking.'
        );
      }
      throw error;
    }
  }

  static async promptForApiKey(provider: Provider): Promise<void> {
    const key = await vscode.window.showInputBox({
      prompt: `Enter API key for ${provider} (stored securely)`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!key) return;
    const settingMap: Record<string, string> = {
      openrouter: 'openrouterApiKey',
      'kilo-gateway': 'kiloGatewayApiKey',
      codik: 'codikApiKey',
    };
    const settingKey = settingMap[provider];
    if (!settingKey) {
      vscode.window.showWarningMessage(`No settings key for provider: ${provider}`);
      return;
    }
    if (ConfigManager.secretStorage) {
      await ConfigManager.secretStorage.store(`omni.${settingKey}`, key);
      ConfigManager.secretCache[settingKey] = key;
    }
    vscode.window.showInformationMessage(`Omni: ${provider} API key saved securely.`);
  }
}
