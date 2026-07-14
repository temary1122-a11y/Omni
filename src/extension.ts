import * as path from 'path';

import * as vscode from 'vscode';

import { OmniOrchestrator } from './core/OmniOrchestrator';
import { MemoryFacade } from './memory/MemoryFacade';

import { OmniPanel, WebviewBridgeImpl, setOrchestrator, getOrchestrator } from './webview/OmniPanel';

import { OmniSidebarProvider } from './webview/OmniSidebarProvider';

import { ConfigManager } from './config/ConfigManager';

import { FreeModelCapabilityRegistry } from './routing/ModelCapabilityRegistry';

import { initLLMLogger } from './routing/LLMLogger';


function notifyChat(bridge: WebviewBridgeImpl, role: 'system' | 'user' | 'assistant', content: string): void {
  try {
    bridge.send({ type: 'CHAT_MESSAGE', payload: { role, content, timestamp: Date.now() } } as any);
  } catch {
    /* webview may not be ready yet */
  }
}

function notifyError(bridge: WebviewBridgeImpl, message: string, phase: string): void {
  try {
    bridge.send({ type: 'ERROR_OCCURRED', payload: { error: message, phase: phase as any, recoverable: true } } as any);
  } catch {
    /* webview may not be ready yet */
  }
}


export async function activate(context: vscode.ExtensionContext): Promise<void> {

  const log = vscode.window.createOutputChannel('Omni');

  try {

    console.log('Omni extension activated');

    log.appendLine('Omni extension activated');

    ConfigManager.initSecretStorage(context.secrets);
    await ConfigManager.preloadSecrets();

    // Check API key configuration
    const config = ConfigManager.load();
    const apiKeys = ConfigManager.toApiKeys(config);
    const hasAnyKey = Object.values(apiKeys).some(k => k && k.length > 0);
    
    log.appendLine(`API Keys Status:`);
    log.appendLine(`  OpenRouter: ${apiKeys.openrouter ? 'SET' : 'NOT SET'}`);
    log.appendLine(`  Kilo Gateway: ${apiKeys['kilo-gateway'] ? 'SET' : 'NOT SET'}`);
    log.appendLine(`  Codik: ${apiKeys.codik ? 'SET' : 'NOT SET'}`);
    log.appendLine(`  Preferred Provider: ${config.preferredProvider}`);
    log.appendLine(`  Budget: ${config.budget}`);
    
    if (!hasAnyKey) {
      log.appendLine('WARNING: No API keys configured. Omni will use fallback mode.');
      vscode.window.showWarningMessage(
        'Omni: No API keys configured. Please configure an API key (OpenRouter, Kilo Gateway, or Codik) via the Omni settings or run "Omni: Configure API Keys" command.'
      );
    }

    const llmChannel = vscode.window.createOutputChannel('Omni LLM');

    initLLMLogger(llmChannel);

    context.subscriptions.push(llmChannel, log);


    const bridge = new WebviewBridgeImpl();


    context.subscriptions.push(

      vscode.window.registerWebviewViewProvider(OmniSidebarProvider.viewType, new OmniSidebarProvider(bridge), {

        webviewOptions: { retainContextWhenHidden: true },

      })

    );


    context.subscriptions.push(

      vscode.commands.registerCommand('omni.openCockpit', () => OmniPanel.createOrShow(bridge)),


      vscode.commands.registerCommand('omniflow.openCockpit', () => vscode.commands.executeCommand('omni.openCockpit')),
      

      

      vscode.commands.registerCommand('omni.start', async (goal?: string, mode?: string) => {
        console.log('[extension.ts] omni.start COMMAND CALLED with goal:', goal);
        log.appendLine(`[Omni] omni.start COMMAND CALLED goal=${goal ?? '<none>'}`);
        const fail = (msg: string, phase = 'intake') => {
          notifyError(bridge, msg, phase);
          vscode.window.showErrorMessage(`Omni: ${msg}`);
        };
        try {
          log.appendLine(`[Omni] omni.start invoked goal=${goal ?? '<none>'}`);
          if (!goal) {
            goal = await vscode.window.showInputBox({
              prompt: 'What should Omni build for you?',
              placeHolder: 'e.g. Build a REST API with Express and TypeScript',
              ignoreFocusOut: true,
            });
          }
          if (!goal) return;
          console.log('[extension.ts] Goal confirmed:', goal);
          notifyChat(bridge, 'system', `Omni received your task: "${goal}". Starting orchestration…`);
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          // Single unified mode: the orchestrator's IntentRouter decides the
          // path (chat / research / code) per message, so we no longer branch on
          // a forced UI mode here. A pure question works without an open folder;
          // a build intent that truly needs the workspace will surface a clear
          // error inside the pipeline if no folder is open.
          if (!root) {
            notifyChat(bridge, 'system', 'No workspace folder is open — chat/research will still work; a build task may be limited.');
          }
          log.appendLine(`[Omni] start goal=${goal}`);
          try {
            OmniPanel.createOrShow(bridge);
          } catch (e) {
            fail(`Failed to open Omni Cockpit: ${e instanceof Error ? e.message : e}`, 'intake');
            return;
          }
          const existing = getOrchestrator();
          if (existing && existing.isCurrentlyRunning()) {
            log.appendLine('[Omni] start ignored — orchestration already running');
            return;
          }
          const orch = existing ?? new OmniOrchestrator(root ?? '');
          if (!existing) {
            orch.setWebviewBridge(bridge);
          }
          setOrchestrator(orch);
          log.appendLine(`[Omni] orch started, awaiting start...`);
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Omni Orchestration', cancellable: false },
            async () => {
              try {
                log.appendLine(`[Omni] calling orch.start`);
                 await orch.start(goal!, mode);
                log.appendLine(`[Omni] orchestration complete`);
                vscode.window.showInformationMessage('Omni: Orchestration complete!');
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.appendLine(`[Omni] failed: ${msg}`);
                if (e instanceof Error && e.stack) log.appendLine(e.stack);
                fail(`Orchestration failed: ${msg}`, 'intake');
              } finally {
                setOrchestrator(null);
              }
            }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.appendLine(`[Omni] start command error: ${msg}`);
          if (err instanceof Error && err.stack) log.appendLine(err.stack);
          fail(`Start error: ${msg}`, 'intake');
        }
      }),

      vscode.commands.registerCommand('omni.continueChat', async (goal?: string) => {
        console.log('[extension.ts] omni.continueChat COMMAND CALLED with goal:', goal);
        log.appendLine(`[Omni] continueChat goal=${goal ?? '<none>'}`);
        const fail = (msg: string) => {
          notifyError(bridge, msg, 'chat');
          vscode.window.showErrorMessage(`Omni: ${msg}`);
        };
        try {
          if (!goal) return;
          try {
            OmniPanel.createOrShow(bridge);
          } catch (e) {
            fail(`Failed to open Omni Cockpit: ${e instanceof Error ? e.message : e}`);
            return;
          }
          const existing = getOrchestrator();
          if (existing && existing.isCurrentlyRunning()) {
            log.appendLine('[Omni] continueChat ignored — orchestration already running');
            return;
          }
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          const orch = existing ?? new OmniOrchestrator(root ?? '');
          if (!existing) {
            orch.setWebviewBridge(bridge);
            setOrchestrator(orch);
          }
          log.appendLine(`[Omni] orch.continueChat...`);
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Omni Chat', cancellable: false },
            async () => {
              try {
                await orch.continueChat(goal);
                vscode.window.showInformationMessage('Omni: Response complete!');
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                log.appendLine(`[Omni] continueChat failed: ${msg}`);
                fail(`Chat failed: ${msg}`);
              }
            }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.appendLine(`[Omni] continueChat error: ${msg}`);
          fail(`Chat error: ${msg}`);
        }
      }),
      

      

      vscode.commands.registerCommand('omniflow.start', (goal?: string) => vscode.commands.executeCommand('omni.start', goal)),
      vscode.commands.registerCommand('omni.openArtifact', async (filePath?: string) => {

        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

        if (!root || !filePath) return;

        const uri = vscode.Uri.file(path.join(root, filePath));

        const doc = await vscode.workspace.openTextDocument(uri);

        await vscode.window.showTextDocument(doc);

      }),


      vscode.commands.registerCommand('omni.configureApi', async () => {

        const pick = await vscode.window.showQuickPick(

          ['openrouter', 'kilo-gateway', 'codik'].map((p) => ({ label: p, description: 'Set API key' })),

          { placeHolder: 'Select provider to configure' }

        );

        if (pick) await ConfigManager.promptForApiKey(pick.label as 'openrouter' | 'kilo-gateway' | 'codik');

      }),



      vscode.commands.registerCommand('omni.selectModel', async () => {
        const config = vscode.workspace.getConfiguration('omni');
        const registry = new FreeModelCapabilityRegistry();
        const grouped = registry.getFreeModelsGroupedByProvider();
        const models: Array<{ label: string; description: string; provider?: string; smartFree?: boolean }> = [
          {
            label: 'Smart-free (auto)',
            description: 'Pick free models automatically per role/provider',
            smartFree: true,
          },
        ];
        for (const [provider, modelList] of Object.entries(grouped)) {
          for (const m of modelList) {
            models.push({
              label: `${provider}/${m.modelId}`,
              description: `${provider} - ${m.roleSuitability.join(', ')}`,
              provider,
            });
          }
        }
        const selected = await vscode.window.showQuickPick(models, {
          placeHolder: 'Select LLM model',
        });
        if (selected) {
          if (selected.smartFree) {
            await config.update('budget', 'free', vscode.ConfigurationTarget.Global);
            await config.update('orchestratorModel', '', vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('Smart-free routing enabled');
            return;
          }
          await config.update('preferredProvider', selected.provider!, vscode.ConfigurationTarget.Global);
          await config.update('orchestratorModel', selected.label, vscode.ConfigurationTarget.Global);
          vscode.window.showInformationMessage(`Orchestrator model set to: ${selected.label}`);
        }
      }),


      vscode.commands.registerCommand('omni.showState', () => {

        vscode.window.showInformationMessage('Use the Omni Cockpit panel for live state.');

      })

    );


    if (vscode.window.registerWebviewPanelSerializer) {

      context.subscriptions.push(

        vscode.window.registerWebviewPanelSerializer('omni-cockpit', {

          async deserializeWebviewPanel() {

            OmniPanel.createOrShow(bridge);

          },

        })

      );

    }

  } catch (err) {

    const message = err instanceof Error ? err.message : String(err);

    log.appendLine(`Activation failed: ${message}`);

    if (err instanceof Error && err.stack) {

      log.appendLine(err.stack);

    }

    vscode.window.showErrorMessage(`Omni failed to activate: ${message}`);

    throw err;

  }

}



export function deactivate(): void {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const mem = MemoryFacade.getInstance(root);
    mem.flushToDisk(true);
  }
  setOrchestrator(null);
}