import * as fs from 'fs';
import * as path from 'path';
import { CrossPlatformShell } from '../shell/CrossPlatformShell';
import type { ArtifactManager } from '../artifacts/ArtifactManager';
import type { EventBus } from '../core/EventBus';

export interface RunInstructionsDeps {
  workspaceRoot: string;
  eventBus: EventBus;
  artifacts: ArtifactManager;
}

/** Detect how the user should run generated output. */
export async function detectRunInstructions(deps: RunInstructionsDeps): Promise<string> {
  const pkgPath = path.join(deps.workspaceRoot, 'generated', 'package.json');
  const readmePath = path.join(deps.workspaceRoot, 'generated', 'README.md');
  if (fs.existsSync(pkgPath)) {
    try {
      const result = await CrossPlatformShell.exec('npm install', {
        cwd: path.join(deps.workspaceRoot, 'generated'),
        timeout: 60_000,
      });
      deps.eventBus.emit({
        type: 'COMMAND_OUTPUT',
        payload: {
          command: 'npm install (generated/)',
          output: CrossPlatformShell.summarizeOutput(result),
          exitCode: result.exitCode,
        },
      });
      if (result.exitCode !== 0) {
        const message = result.exitCode === null
          ? 'npm install timed out'
          : `npm install exited with code ${result.exitCode}`;
        deps.eventBus.emit({
          type: 'ERROR_OCCURRED',
          payload: { error: message, phase: 'deliver', recoverable: true },
        });
        return `Dependency installation failed (${message}). Run: cd generated && npm install && npm start`;
      }
      return 'cd generated && npm install && npm start';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.eventBus.emit({
        type: 'ERROR_OCCURRED',
        payload: {
          error: `Unable to install generated dependencies: ${message}`,
          phase: 'deliver',
          recoverable: true,
        },
      });
      return `Dependency installation failed (${message}). Run: cd generated && npm install && npm start`;
    }
  }
  if (fs.existsSync(readmePath)) return 'See generated/README.md for instructions';
  const tsFiles = deps.artifacts.listGenerated().filter((f) => f.endsWith('.ts'));
  if (tsFiles.length) return `npx ts-node ${tsFiles[0]}`;
  return 'Open generated/ artifacts in the workspace';
}
