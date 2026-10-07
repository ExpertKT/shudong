/**
 * 冒烟：只验证一件事 —— 上游真的会**流式吐出正文**。
 * 这里最常坏的两种：模型没关思考导致 content 永远为空；上游协议不是 OpenAI 那套。
 * 跑法：pnpm --filter @shudong/server smoke
 */
import { env } from './env.ts';
import { streamChat, target, type Usage } from './llm.ts';
import { PERSONAS, systemPrompt } from './personas.ts';

const POST = '最近老是到两三点才睡着，白天整个人是木的，什么事都做不进去。';
const t = target('default');

console.log(`上游 ${t.baseURL}`);
console.log(`模型 ${t.model}（reasoning_off=${env.reasoningOff}，附加参数 ${JSON.stringify(t.extra)}）`);

for (const p of PERSONAS) {
  let usage: Usage | null = null;
  let text = '';
  const t0 = Date.now();
  try {
    for await (const chunk of streamChat(
      [
        { role: 'system', content: systemPrompt(p, '小满', null) },
        { role: 'user', content: POST },
      ],
      { maxTokens: p.maxTokens, onUsage: (u) => (usage = u) },
    )) {
      text += chunk;
    }
  } catch (e) {
    console.log(`\n=== ${p.name} 调用失败 ===`);
    console.log(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
    continue;
  }

  const ms = Date.now() - t0;
  const tok = usage ? (usage as Usage).completion_tokens : undefined;
  console.log(`\n=== ${p.name}（${p.slug}）${ms}ms / completion_tokens=${tok ?? '?'} ===`);
  if (!text.trim()) {
    console.log('!!! 空回复：content 一个字符都没吐出来');
    process.exitCode = 1;
    continue;
  }
  console.log(text);
}
