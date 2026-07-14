/**
 * Command safety heuristics for host-side (non-sandboxed) execution.
 *
 * When Docker is unavailable the harness would otherwise run LLM-generated
 * commands directly on the host. This module provides a conservative block-list
 * of patterns that can irreversibly damage the machine, so such commands are
 * refused even when the user has opted into local execution.
 *
 * The check is intentionally coarse — it favours refusing a dangerous-looking
 * command over allowing a catastrophic one. It is a safety net, not a full
 * sandbox; real isolation still requires Docker.
 */

export interface CommandSafetyResult {
  safe: boolean;
  /** Human-readable reason a command was refused (undefined when safe). */
  reason?: string;
}

interface DangerRule {
  pattern: RegExp;
  reason: string;
}

/**
 * Patterns that indicate a destructive or system-altering command. Cross-platform
 * (POSIX shells + Windows cmd/PowerShell). Ordered roughly by severity.
 */
export const DANGEROUS_COMMAND_RULES: readonly DangerRule[] = [
  // Recursive force-delete of root, home, or a drive root.
  {
    pattern: /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*\b[^\n|&;]*\s(\/|~|\/\*|\.\/?|\$HOME)\s*($|[|&;])/i,
    reason: 'recursive/forced deletion of root, home, or current directory',
  },
  { pattern: /\brm\s+-[a-z]*[rf][a-z]*\s+\/(\s|$)/i, reason: 'recursive/forced deletion of filesystem root' },
  // Windows destructive delete of a drive root or whole tree.
  { pattern: /\b(del|erase)\b[^\n]*\/[sq][^\n]*[a-z]:\\?(\s|$|\*)/i, reason: 'recursive deletion of a Windows drive' },
  { pattern: /\brmdir\b[^\n]*\/s[^\n]*[a-z]:\\?(\s|$)/i, reason: 'recursive deletion of a Windows drive' },
  { pattern: /Remove-Item\b[^\n]*-Recurse[^\n]*(-Force[^\n]*)?\s+[a-z]:\\?(\s|$|\*|['"]?[a-z]:\\)/i, reason: 'recursive/forced deletion of a Windows drive' },
  // Disk / filesystem destruction.
  { pattern: /\bmkfs(\.\w+)?\b/i, reason: 'filesystem creation (disk wipe)' },
  { pattern: /\bdd\b[^\n]*\bof=\/dev\/(sd|nvme|hd|disk|vd)/i, reason: 'raw write to a block device' },
  { pattern: /\b(fdisk|parted|diskpart)\b/i, reason: 'disk partitioning' },
  // Windows `format <drive>:` — scoped to a drive letter to avoid matching `npm run format`.
  { pattern: /\bformat\s+(\/[a-z:]+\s+)*[a-z]:/i, reason: 'disk formatting' },
  { pattern: />\s*\/dev\/(sd|nvme|hd|disk|vd)\w*/i, reason: 'redirect to a raw block device' },
  // Fork bomb.
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork bomb' },
  // Pipe a remote download straight into a shell/interpreter.
  { pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n]*\|\s*(sudo\s+)?(sh|bash|zsh|python\d?|node|powershell|pwsh|iex|invoke-expression)\b/i, reason: 'piping a remote download directly into a shell' },
  { pattern: /\b(iwr|invoke-webrequest|curl)\b[^\n]*\|\s*iex\b/i, reason: 'piping a remote download into Invoke-Expression' },
  // System power state.
  { pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/i, reason: 'system shutdown/reboot' },
  // Overly-broad permission/ownership changes on root.
  { pattern: /\bchmod\s+(-[a-z]*\s+)*[0-7]{3,4}\s+(-[a-z]*\s+)*\/(\s|$)/i, reason: 'permission change on filesystem root' },
  { pattern: /\bchown\s+[^\n]*\s\/(\s|$)/i, reason: 'ownership change on filesystem root' },
  { pattern: /\bchmod\s+-R\b[^\n]*\s(\/|~)(\s|$)/i, reason: 'recursive permission change on root/home' },
  // Destroy git history / working tree.
  { pattern: /\bgit\s+reset\s+--hard\b/i, reason: 'destructive git reset (discards local changes)' },
  { pattern: /\bgit\s+clean\s+-[a-z]*f[a-z]*d\b/i, reason: 'git clean removes untracked files' },
  // Windows registry deletion of a root hive.
  { pattern: /\breg\s+delete\s+HK(LM|CU|CR|U|CC)\b/i, reason: 'Windows registry hive deletion' },
];

/**
 * Assess whether a command is safe to run directly on the host.
 * Returns `{ safe: false, reason }` when it matches a destructive pattern.
 */
export function assessCommandSafety(command: string): CommandSafetyResult {
  const normalized = (command ?? '').trim();
  if (!normalized) return { safe: true };

  for (const rule of DANGEROUS_COMMAND_RULES) {
    if (rule.pattern.test(normalized)) {
      return { safe: false, reason: rule.reason };
    }
  }
  return { safe: true };
}
