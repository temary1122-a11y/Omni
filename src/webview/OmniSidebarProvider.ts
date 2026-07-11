import * as vscode from 'vscode';
import * as path from 'path';
import { buildCockpitHtml, handleCockpitMessage, injectCsp, WebviewBridgeImpl } from './OmniPanel';

export class OmniSidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'omni.cockpit';

  private disposables: vscode.Disposable[] = [];

  constructor(private readonly bridge: WebviewBridgeImpl) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      // Allow the built webview-ui assets to load (and the extension root so the
      // host-wired build resolves its bundled resources).
      localResourceRoots: [
        vscode.Uri.file(path.join(extensionRoot(), 'dist', 'webview-ui')),
        vscode.Uri.file(path.join(extensionRoot(), 'dist', 'webview-ui', 'assets')),
        vscode.Uri.file(extensionRoot()),
      ],
    };

    // Apply webview URI routing to sidebar as well
    const html = buildCockpitHtml();
    const webviewUri = (filePath: string) => {
      const uri = vscode.Uri.file(path.join(extensionRoot(), 'dist', 'webview-ui', filePath));
      return webviewView.webview.asWebviewUri(uri);
    };
    const processedHtml = html.replace(/(href|src)="\/assets\/([^"]+)"/g, (match, attr, filename) => {
      const uri = webviewUri(`assets/${filename}`);
      console.debug(`[OmniSidebarProvider] Replacing ${match} with ${attr}="${uri}"`);
      return `${attr}="${uri}"`;
    });
    // Inject a CSP that whitelists the active webview resource origin so the
    // inlined bundle is never silently blocked (grey screen).
    webviewView.webview.html = injectCsp(processedHtml, webviewView.webview);

    // Set up message handler BEFORE adding webview to bridge
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((msg) => {
        console.debug('[OmniSidebarProvider] Received message:', msg);
        handleCockpitMessage(msg);
      })
    );

    // Add webview to bridge AFTER message handler is set up
    // This ensures BACKEND_READY is sent when webview is ready to receive it
    this.bridge.addWebview(webviewView.webview);

    webviewView.onDidDispose(
      () => {
        this.bridge.removeWebview(webviewView.webview);
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
      },
      null,
      this.disposables
    );
  }
}

function extensionRoot(): string {
  // The sidebar provider is instantiated from extension.ts; resolve the extension
  // root from this module's location (webview/ -> src -> extension root).
  return path.resolve(__dirname, '..', '..', '..');
}
