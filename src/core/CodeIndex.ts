/**
 * Vertical Code Index - abstraction layer for AST-based code search.
 *
 * North Star: agents receive precise code coordinates instead of text search.
 */

export interface SymbolLocation {
  /** Absolute file path */
  file: string;
  /** 1-based line number */
  line: number;
  /** Optional 1-based end line */
  endLine?: number;
  /** Optional signature / declaration text */
  signature?: string;
  /** Optional symbol kind */
  kind?: 'function' | 'class' | 'interface' | 'method' | 'variable' | 'constant' | 'enum' | 'type';
}

export interface DependencyEdge {
  /** Import path / module reference */
  target: string;
  /** Source file where dependency is used */
  source: string;
  /** Kind of dependency */
  kind: 'import' | 'export' | 'require' | 'dynamic-import';
  /** Line where dependency appears */
  line?: number;
}

export interface SearchResult {
  /** Absolute file path */
  file: string;
  /** 1-based start line */
  startLine: number;
  /** 1-based end line */
  endLine: number;
  /** Code block text */
  snippet: string;
  /** Relevance score (0-1, higher is better) */
  score: number;
}

export interface CodeIndexOptions {
  /** Root path to index */
  workspaceRoot: string;
  /** Optional path to probe binary */
  probeBinary?: string;
  /** Maximum tokens returned per query */
  maxTokens?: number;
  /** Whether to include test files */
  allowTests?: boolean;
}

/**
 * Abstraction for structural code search.
 *
 * Implementations:
 * - ProbeWrapper (Probe CLI / SDK)
 * - Future: LeIndex, tree-sitter direct, etc.
 */
export interface CodeIndex {
  findSymbol(name: string, options?: { kind?: string }): Promise<SymbolLocation | null>;
  findDependencies(filePath: string): Promise<{ imports: DependencyEdge[]; exports: DependencyEdge[] }>;
  semanticSearch(query: string, options?: { maxResults?: number; language?: string }): Promise<SearchResult[]>;
  isAvailable(): Promise<boolean>;
}
