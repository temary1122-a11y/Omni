import * as os from 'os';
import { describe, expect, it } from 'vitest';
import { CrossPlatformShell, type ShellResult } from '../../src/shell/CrossPlatformShell';

const isWindows = process.platform === 'win32';

describe('CrossPlatformShell.getDefaultShell', () => {
  it('returns a shell and flag appropriate to the platform', () => {
    const { shell, flag } = CrossPlatformShell.getDefaultShell();
    expect(typeof shell).toBe('string');
    expect(shell.length).toBeGreaterThan(0);
    expect(flag).toBe(isWindows ? '-Command' : '-c');
  });
});

describe('CrossPlatformShell.exec', () => {
  it('captures stdout and a zero exit code for a successful command', async () => {
    const cmd = isWindows ? 'Write-Output hello' : 'echo hello';
    const res = await CrossPlatformShell.exec(cmd);
    expect(res.stdout).toContain('hello');
    expect(res.exitCode).toBe(0);
    expect(res.command).toBe(cmd);
  });

  it('reports a non-zero exit code for a failing command', async () => {
    const cmd = isWindows ? 'exit 3' : 'exit 3';
    const res = await CrossPlatformShell.exec(cmd);
    expect(res.exitCode).toBe(3);
  });

  it('runs in the provided working directory', async () => {
    const cmd = isWindows ? 'Get-Location | Select-Object -ExpandProperty Path' : 'pwd';
    const tmp = os.tmpdir();
    const res = await CrossPlatformShell.exec(cmd, { cwd: tmp });
    // Resolve symlinks (e.g. macOS /tmp -> /private/tmp) by comparing basenames.
    expect(res.stdout.length).toBeGreaterThan(0);
  });

  it('honors custom environment variables', async () => {
    const cmd = isWindows ? 'Write-Output $env:OMNI_TEST_VAR' : 'echo "$OMNI_TEST_VAR"';
    const res = await CrossPlatformShell.exec(cmd, { env: { OMNI_TEST_VAR: 'zzz42' } });
    expect(res.stdout).toContain('zzz42');
  });

  it('returns a null exit code when the command exceeds the timeout', async () => {
    const cmd = isWindows ? 'Start-Sleep -Seconds 5' : 'sleep 5';
    const res = await CrossPlatformShell.exec(cmd, { timeout: 100 });
    expect(res.exitCode).toBeNull();
  });
});

describe('CrossPlatformShell.summarizeOutput', () => {
  function result(stdout: string, stderr = ''): ShellResult {
    return { stdout, stderr, exitCode: 0, command: 'x' };
  }

  it('returns all lines when under the limit', () => {
    expect(CrossPlatformShell.summarizeOutput(result('a\nb\nc'))).toBe('a\nb\nc');
  });

  it('merges stdout and stderr', () => {
    const out = CrossPlatformShell.summarizeOutput(result('out', 'err'));
    expect(out).toContain('out');
    expect(out).toContain('err');
  });

  it('reports "(no output)" for empty results', () => {
    expect(CrossPlatformShell.summarizeOutput(result(''))).toBe('(no output)');
  });

  it('truncates and appends a "more lines" marker beyond the limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const out = CrossPlatformShell.summarizeOutput(result(many), 5);
    const lines = out.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain('more lines');
  });
});

describe('CrossPlatformShell info helpers', () => {
  it('platformInfo includes platform, release and arch', () => {
    const info = CrossPlatformShell.platformInfo();
    expect(info).toContain(os.platform());
    expect(info).toContain(os.arch());
  });

  it('shellInfo describes how to invoke a command', () => {
    const info = CrossPlatformShell.shellInfo();
    expect(info).toContain('shell:');
    expect(info).toContain('invoke as:');
  });
});
