import { env } from './env.ts';

export type Msg = { role: 'system' | 'user' | 'assistant'; content: string };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };

type Target = { baseURL: string; apiKey: string; model: string; extra: Record<string, unknown> };

export type ModelChoice = { delayMs: number; fast: string; slow: string; afterSec: number };
export function pickModel({ delayMs, fast, slow, afterSec }: ModelChoice): string {
  return slow && delayMs > afterSec * 1000 ? slow : fast;
}

/** 所有供应商都走 OpenAI 兼容协议，所以"换模型"只是换三个环境变量。 */
export function target(tier: 'default' | 'small' | 'slow'): Target {
  if (tier === 'slow' && env.slowModel) {
    return { baseURL: env.baseURL, apiKey: env.apiKey, model: env.slowModel, extra: env.reasoningOff ? { reasoning_effort: 'none' } : {} };
  }
  if (tier === 'small' && env.smallBaseURL) {
    return { baseURL: env.smallBaseURL, apiKey: env.smallApiKey, model: env.smallModel, extra: {} };
  }
  return {
    baseURL: env.baseURL,
    apiKey: env.apiKey,
    model: env.model,
    // ⚠️ Qwen3.5 不关思考会把 token 全烧在 reasoning 上，content 永远是空的
    extra: env.reasoningOff ? { reasoning_effort: 'none' } : {},
  };
}

/**
 * 流式对话，逐段吐出正文（reasoning_content 一律丢弃，不能漏进回复）。
 */
export async function* streamChat(
  messages: Msg[],
  opts: {
    tier?: 'default' | 'small' | 'slow';
    temperature?: number;
    maxTokens?: number;
    onUsage?: (u: Usage) => void;
    signal?: AbortSignal;
  } = {},
): AsyncGenerator<string> {
  const t = target(opts.tier ?? 'default');
  const res = await fetch(`${t.baseURL.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${t.apiKey}` },
    body: JSON.stringify({
      model: t.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0.9,
      max_tokens: opts.maxTokens ?? 400,
      ...t.extra,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`上游 ${res.status} (${t.model})：${body.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return;

      let json: any;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // 上游偶发的非 JSON 心跳行
      }
      if (json.usage) opts.onUsage?.(json.usage);
      const text = json.choices?.[0]?.delta?.content;
      if (typeof text === 'string' && text) yield text;
    }
  }
}

/** 非流式，用于"更新印象"这种要 JSON 的小调用。 */
export async function chatOnce(
  messages: Msg[],
  opts: { tier?: 'default' | 'small'; maxTokens?: number; onUsage?: (u: Usage) => void } = {},
): Promise<string> {
  let out = '';
  for await (const chunk of streamChat(messages, {
    tier: opts.tier,
    maxTokens: opts.maxTokens,
    temperature: 0.3,
    onUsage: opts.onUsage,
  })) {
    out += chunk;
  }
  return out.trim();
}
