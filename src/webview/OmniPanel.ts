import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { IpcMessage } from '../../shared/types';
import type { WebviewBridge } from '../core/EventBus';
import { OmniOrchestrator } from '../core/OmniOrchestrator';
import { ConfigManager } from '../config/ConfigManager';
import { FreeModelCapabilityRegistry } from '../routing/ModelCapabilityRegistry';

export class WebviewBridgeImpl implements WebviewBridge {
  // A single shared bridge backs BOTH the sidebar view and the cockpit panel.
  // Broadcast every event to every registered webview so the orchestration
  // output shows up in whichever surface the user is actually looking at
  // (submitting from the sidebar must not silently route events to the cockpit).
  private webviews = new Set<vscode.Webview>();

  setWebview(w: vscode.Webview): void {
    this.addWebview(w);
  }

  addWebview(w: vscode.Webview): void {
    console.log('[WebviewBridge] addWebview called, total webviews:', this.webviews.size);
    this.webviews.add(w);
    const sendReady = () => {
      try {
        console.log('[WebviewBridge] Sending BACKEND_READY to webview');
        w.postMessage({ type: 'BACKEND_READY', payload: { version: '1.0' } } as any);
      } catch (e) {
        console.error('[WebviewBridge] Failed to send BACKEND_READY:', e);
        /* webview may not be fully ready yet */
      }
    };
    // Handshake: tell the freshly-attached webview the real backend is reachable.
    // This is the authoritative signal the UI uses to stop treating itself as a
    // standalone demo. Re-send shortly after in case the webview's message
    // listener attached late.
    sendReady();
    setTimeout(sendReady, 600);
  }

  removeWebview(w: vscode.Webview): void {
    this.webviews.delete(w);
  }

  get hasWebview(): boolean {
    return this.webviews.size > 0;
  }

  send(event: IpcMessage): void {
    if (this.webviews.size === 0) {
      console.warn('WebviewBridge: no webview registered, cannot send message:', event.type);
      return;
    }
    for (const w of this.webviews) {
      try {
        w.postMessage(event);
      } catch (e) {
        console.error('WebviewBridge: failed to post message:', e);
        this.webviews.delete(w);
      }
    }
  }
}

let orchestrator: OmniOrchestrator | null = null;

export function getOrchestrator(): OmniOrchestrator | null {
  return orchestrator;
}

export function setOrchestrator(o: OmniOrchestrator | null): void {
  orchestrator = o;
}

export async function handleCockpitMessage(msg: {
  command: string;
  goal?: string;
  answers?: unknown[];
  filePath?: string;
  requestId?: string;
  approved?: boolean;
  feedback?: string;
  url?: string;
  envVar?: string;
  value?: string;
  action?: string;
  keys?: Record<string, string>;
  agentId?: string;
  budget?: 'free' | 'low' | 'normal' | 'high';
  useSupervisor?: boolean;
  chatVerbosity?: string;
  mode?: string;
}): Promise<void> {
  console.log('[OmniPanel] handleCockpitMessage RECEIVED:', JSON.stringify(msg, null, 2));
  try {
    switch (msg.command) {
      case 'start':
        console.log('[OmniPanel] START command received with goal:', msg.goal);
        if (msg.goal) {
          console.log('[OmniPanel] executing omni.start for:', msg.goal);
          await vscode.commands.executeCommand('omni.start', msg.goal, msg.mode);
          console.log('[OmniPanel] omni.start command executed');
        } else {
          console.warn('[OmniPanel] START command received but no goal provided');
        }
        break;
      case 'submitAnswers':
        getOrchestrator()?.submitClarifyingAnswers(
          (msg.answers ?? []) as Parameters<OmniOrchestrator['submitClarifyingAnswers']>[0]
        );
        break;
      case 'submitApproval':
        getOrchestrator()?.submitApproval({
          requestId: msg.requestId || '',
          approved: !!msg.approved,
          feedback: msg.feedback,
        } as Parameters<OmniOrchestrator['submitApproval']>[0]);
        break;
      case 'openArtifact':
        if (msg.filePath) await vscode.commands.executeCommand('omni.openArtifact', msg.filePath);
        break;
      case 'configureApi':
        await vscode.commands.executeCommand('omni.configureApi');
        break;
      case 'openExternal':
        if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'submitApiKeyPrompt':
        if (msg.requestId && msg.action) {
          if (msg.action === 'proceed' && msg.keys) {
            for (const [envVar, value] of Object.entries(msg.keys)) {
              if (value) await ConfigManager.setToolApiKey(envVar, value);
            }
            getOrchestrator()?.refreshApiKeys();
          }
          getOrchestrator()?.submitApiKeyPrompt({
            requestId: msg.requestId,
            action: msg.action as 'proceed' | 'skip' | 'fallback',
            keys: msg.keys,
          });
        }
        break;
      case 'selectModel':
        await vscode.commands.executeCommand('omni.selectModel');
        break;
      case 'requestWorkspace':
        getOrchestrator()?.requestWorkspaceTree();
        break;
      case 'stopGeneration':
        getOrchestrator()?.requestStop();
        break;
      case 'pauseSession':
        getOrchestrator()?.requestPause();
        break;
      case 'continueSession':
        getOrchestrator()?.requestResume();
        break;
      case 'exportSession': {
        const orch = getOrchestrator();
        if (!orch) break;
        const data = orch.exportSessionSnapshot();
        const doc = await vscode.workspace.openTextDocument({
          content: JSON.stringify(data, null, 2),
          language: 'json',
        });
        await vscode.window.showTextDocument(doc, { preview: false });
        break;
      }
      case 'switchAgent':
        if (msg.agentId) {
          vscode.commands.executeCommand('omni.openCockpit');
        }
        break;
      case 'updateSettings':
        await ConfigManager.updateSettings({
          budget: (msg as { budget?: 'free' | 'low' | 'normal' | 'high' }).budget,
          useSupervisor: (msg as { useSupervisor?: boolean }).useSupervisor,
        });
        getOrchestrator()?.refreshApiKeys();
        if ((msg as { useSupervisor?: boolean }).useSupervisor !== undefined) {
          getOrchestrator()?.setSupervisorMode(!!(msg as { useSupervisor?: boolean }).useSupervisor);
        }
        break;
    }
  } catch (e) {
    console.error('[OmniPanel] message handling failed:', e);
    vscode.window.showErrorMessage(`Omni UI error: ${e instanceof Error ? e.message : e}`);
  }
}

/**
 * Inject a Content-Security-Policy into the webview HTML.
 *
 * The built webview ships WITHOUT a CSP meta tag, so VS Code would fall back to
 * its default policy. When the webview resource CDN is active (recent VS Code
 * builds serve assets from `https://file+.vscode-resource.vscode-cdn.net`), the
 * external `type="module"` bundle can be blocked by that default policy — a
 * silent failure that leaves the webview permanently grey.
 *
 * Using `webview.cspSource` is the canonical, mode-agnostic fix: VS Code sets it
 * to `'self' https://*.vscode-cdn.net` in CDN mode and to the `vscode-webview:`
 * origin otherwise, so the asset origin is always whitelisted. `'unsafe-inline'`
 * is required for the inlined bundle produced by vite-plugin-singlefile.
 */
export function injectCsp(html: string, webview: vscode.Webview): string {
  const csp = [
    "default-src 'none';",
    `img-src ${webview.cspSource} https: data: blob:;`,
    `style-src ${webview.cspSource} 'unsafe-inline';`,
    `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval';`,
    `font-src ${webview.cspSource} https: data:;`,
    `connect-src ${webview.cspSource} https: wss: ws:;`,
  ].join(' ');
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => `${m}\n    ${meta}`);
  }
  return `${meta}\n${html}`;
}

export function buildCockpitHtml(): string {
  const built = tryLoadBuiltWebviewHtml();
  if (!built) {
    throw new Error(
      '[OmniPanel] Built webview-ui not found or not host-wired. ' +
      'Run "npm run webview:build" at the extension root (or simply press F5, which now builds it) ' +
      'before opening the Omni Cockpit view.'
    );
  }
  return built;
}

function tryLoadBuiltWebviewHtml(): string | undefined {
  try {
    const candidate = path.join(__dirname, '..', '..', '..', 'dist', 'webview-ui', 'index.html');
    if (!fs.existsSync(candidate)) return undefined;
    const html = fs.readFileSync(candidate, 'utf-8');
    return html;
  } catch {
    return undefined;
  }
}

export class OmniPanel {
  static current: OmniPanel | undefined;
  private panel: vscode.WebviewPanel;
  private bridge: WebviewBridgeImpl;
  private disposables: vscode.Disposable[] = [];
  private readonly extensionPath?: string;

  private constructor(panel: vscode.WebviewPanel, bridge: WebviewBridgeImpl, extensionPath?: string) {
    this.panel = panel;
    this.bridge = bridge;
    this.extensionPath = extensionPath;
    bridge.addWebview(panel.webview);
    const html = OmniPanel.loadWebviewHtml(panel.webview, extensionPath);
    panel.webview.html = html;
    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg) => {
        console.debug('[OmniPanel] onDidReceiveMessage:', msg);
        handleCockpitMessage(msg);
      })
    );
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.postModelCatalog();
  }

  private static loadWebviewHtml(webview: vscode.Webview, extensionPath?: string): string {
    // Always route through buildCockpitHtml() so the host-wiring guard in
    // tryLoadBuiltWebviewHtml() is applied (rejects orphaned demo builds).
    const html = buildCockpitHtml();
    // Replace asset paths with webview URIs
    const webviewUri = (filePath: string) => {
      const uri = vscode.Uri.file(path.join(extensionRoot(), 'dist', 'webview-ui', filePath));
      return webview.asWebviewUri(uri);
    };
    // Replace all asset file references with webview URIs
    const withUris = html.replace(/(href|src)="\/assets\/([^"]+)"/g, (match, attr, filename) => {
      const uri = webviewUri(`assets/${filename}`);
      console.debug(`[OmniPanel] Replacing ${match} with ${attr}="${uri}"`);
      return `${attr}="${uri}"`;
    });
    // Inject a CSP that whitelists the active webview resource origin (CDN or
    // vscode-webview://) so the bundle is never silently blocked.
    return injectCsp(withUris, webview);
  }

  private postModelCatalog(): void {
    try {
      const registry = new FreeModelCapabilityRegistry();
      const grouped = registry.getFreeModelsGroupedByProvider();
      this.bridge.send({ type: 'modelCatalog', payload: { providers: grouped } } as any);
    } catch (e) {
      console.debug('[OmniPanel] failed to post model catalog:', e);
    }
  }

  static createOrShow(bridge: WebviewBridgeImpl): OmniPanel {
    console.debug('[OmniPanel] createOrShow called');
    if (OmniPanel.current) {
      console.debug('[OmniPanel] revealing existing panel');
      OmniPanel.current.panel.reveal();
      return OmniPanel.current;
    }
    console.debug('[OmniPanel] creating webview panel');
    const panel = vscode.window.createWebviewPanel('omni-cockpit', 'Omni - AI Orchestrator', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionRoot(), 'dist', 'webview-ui')),
        vscode.Uri.file(path.join(extensionRoot(), 'dist', 'webview-ui', 'assets')),
        vscode.Uri.file(extensionRoot()),
      ],
    });
    console.debug('[OmniPanel] panel created');
    OmniPanel.current = new OmniPanel(panel, bridge);
    console.debug('[OmniPanel] OmniPanel instance created');
    return OmniPanel.current;
  }

  dispose(): void {
    OmniPanel.current = undefined;
    this.bridge.removeWebview(this.panel.webview);
    this.panel.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

function extensionRoot(): string {
  // OmniPanel.ts compiles to <ext>/dist/src/webview/OmniPanel.js, so walk up to the
  // extension root for resolving dist/webview-ui and bundled resources.
  return path.resolve(__dirname, '..', '..', '..');
}
