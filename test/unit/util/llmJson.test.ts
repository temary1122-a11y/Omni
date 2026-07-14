import { describe, expect, it } from 'vitest';
import { extractJsonFromLLMResponse } from '../../../src/util/llmJson';

describe('extractJsonFromLLMResponse', () => {
  it('returns plain JSON unchanged', () => {
    const raw = extractJsonFromLLMResponse('[{"id":"a"}]', undefined);
    expect(JSON.parse(raw)).toEqual([{ id: 'a' }]);
  });

  it('strips markdown code fences', () => {
    const raw = extractJsonFromLLMResponse('```json\n{"ok":true}\n```', undefined);
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });

  it('extracts an array embedded in prose', () => {
    const text = 'Here you go:\n[{"id":"x"}]\nHope that helps!';
    const raw = extractJsonFromLLMResponse(text, undefined);
    expect(JSON.parse(raw)).toEqual([{ id: 'x' }]);
  });

  it('extracts a known property array when the object is malformed', () => {
    const text = 'noise "questions": [{"q":1}] trailing garbage {';
    const raw = extractJsonFromLLMResponse(text, undefined);
    expect(JSON.parse(raw)).toEqual([{ q: 1 }]);
  });

  it('falls back to the reasoning field when content has no JSON', () => {
    const raw = extractJsonFromLLMResponse('no json here', '{"from":"reasoning"}');
    expect(JSON.parse(raw)).toEqual({ from: 'reasoning' });
  });

  it('returns content as the default fallback when nothing parses', () => {
    expect(extractJsonFromLLMResponse('not json', undefined)).toBe('not json');
  });

  it('honors an explicit fallback value', () => {
    expect(extractJsonFromLLMResponse('not json', undefined, '')).toBe('');
  });
});
