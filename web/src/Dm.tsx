import { useEffect, useRef, useState } from 'react';
import { api, sse, timeAgo, type AgentMeta, type DmMessage, type Evt } from './api';
import { Avatar, Dots, lit, tint, type Notice } from './bits';

/** 比服务端多一个状态：'typing'（正在吐字）。error 是"这句话为什么没说出来"。 */
type Row = Omit<DmMessage, 'state'> & { state: DmMessage['state'] | 'typing'; error?: string | null };

/** 单聊一屏。回复和帖子一样是一条条吐出来的 —— 用的是同一个读取器。 */
export default function Dm({
  agent,
  onBack,
  onNotice,
  onFriendsChanged,
  onUnfriend,
  signal,
}: {
  agent: AgentMeta;
  onBack: () => void;
  onNotice: (n: Notice | null) => void;
  onFriendsChanged: () => void;
  onUnfriend: () => void;
  /** App 收到"他主动来找你"时 +1：这条线程重新拉一次。 */
  signal: number;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [impression, setImpression] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [boot, setBoot] = useState(0);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let dead = false;
    let stop: (() => void) | null = null;
    setLoading(true);

    const apply = (evt: Evt) => {
      const id = evt.id;
      if (typeof id !== 'number') {
        if (evt.type === 'error') onNotice({ text: evt.message ?? '服务器出了点问题', retry: () => setBoot((b) => b + 1) });
        return;
      }
      setRows((prev) => {
        const known = prev.some((m) => m.id === id);
        if (!known) {
          // 没见过的 id 只可能是它刚好说完了（比如另一个标签页正在生成）。那就把这句话接住。
          if (evt.type === 'done')
            return [
              { id, role: 'agent', text: evt.text ?? '', state: 'done', seen: false, createdAt: Date.now(), origin: 'reply' },
              ...prev,
            ];
          return prev;
        }
        return prev.map((m) => {
          if (m.id !== id) return m;
          if (evt.type === 'agent_start') return { ...m, state: 'typing', text: '' };
          if (evt.type === 'delta') return { ...m, state: 'typing', text: (m.text ?? '') + (evt.text ?? '') };
          if (evt.type === 'done') return { ...m, state: 'done', text: evt.text ?? m.text, error: null };
          if (evt.type === 'error') return { ...m, state: 'failed', error: evt.message ?? null };
          return m;
        });
      });
      if (evt.type === 'done') onFriendsChanged();
    };

    api
      .dm(agent.slug)
      .then((r) => {
        if (dead) return;
        setRows(r.messages);
        setImpression(r.impression);
        setLoading(false);
        setErr('');

        // 进了这屋就算看过了
        void api
          .seenDm(agent.slug)
          .then(() => !dead && onFriendsChanged())
          .catch((e: Error) => !dead && onNotice({ text: `标记已读失败：${e.message}` }));

        // after = 最后一条"已经结束"的 agent 消息：已说完的不重放，挂着的那条照样生成出来
        const settled = r.messages.filter((m) => m.role === 'agent' && m.state !== 'pending').map((m) => m.id);
        const after = settled.length > 0 ? Math.max(...settled) : 0;

        stop = sse(`/api/dm/${encodeURIComponent(agent.slug)}/stream?after=${after}`, {
          event: (evt) => {
            apply(evt);
            if (evt.type === 'complete') {
              stop?.();
              // 流完了还挂着的（另一个标签页正在生成同一条），别让它一直转圈
              setRows((prev) =>
                prev.map((m) => (m.role === 'agent' && m.state === 'pending' ? { ...m, state: 'failed' } : m)),
              );
              void api
                .seenDm(agent.slug)
                .then(() => !dead && onFriendsChanged())
                .catch(() => {});
            }
          },
          error: () => {
            stop?.();
            onNotice({
              text: '聊天流断了 —— 服务可能重启过，或者登录过期了。点「重连」接着等。',
              retry: () => setBoot((b) => b + 1),
            });
          },
        });
      })
      .catch((e: Error) => {
        if (dead) return;
        setLoading(false);
        setErr(e.message);
      });

    return () => {
      dead = true;
      stop?.();
    };
  }, [agent.slug, boot, signal]);

  // 新消息露头就滚到底 —— 聊天窗该有的样子
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [rows.length]);

  async function send() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    onNotice(null);
    try {
      await api.sendDm(agent.slug, body);
      setText('');
      // 重新拉线程：那条 pending 先就位，然后才接流 —— 服务端的流只在连上的那一刻看一次表
      setBoot((b) => b + 1);
      onFriendsChanged();
    } catch (e) {
      // 400 空/超长、403 不是好友、429 撞闸门 —— 服务端原话直出
      onNotice({ text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex min-h-[calc(100dvh-10rem)] flex-col">
      <header className="sticky top-0 z-10 mb-3 flex items-start gap-3 border-b border-white/5 bg-ink/95 py-2 backdrop-blur">
        <button
          className="mt-1 shrink-0 rounded-lg px-1.5 py-1 text-sm text-neutral-500 transition hover:bg-white/5 hover:text-neutral-300"
          onClick={onBack}
        >
          ← 回去
        </button>
        <Avatar name={agent.name} accent={agent.accent} slug={agent.slug} size="big" className="mt-1" />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-sm font-medium" style={{ color: lit(agent.accent) }}>
              {agent.name}
            </span>
            <span className="min-w-0 truncate text-xs text-neutral-600">{agent.tagline}</span>
          </div>
          {impression && (
            // "他会记得你"是这个产品的魂 —— 别折起来，就摆在这儿
            <p className="mt-1 border-l border-white/10 pl-2 text-[11px] leading-relaxed break-words text-neutral-600">
              他记得你：{impression}
            </p>
          )}
        </div>
        <button
          className="mt-1 shrink-0 text-xs text-neutral-700 transition hover:text-rose-300/80"
          onClick={onUnfriend}
        >
          不是好友了
        </button>
      </header>

      <div className="flex-1 space-y-3">
        {loading && <p className="py-8 text-center text-sm text-neutral-700">…</p>}
        {err && <p className="py-8 text-center text-sm leading-relaxed break-words text-rose-300/80">{err}</p>}
        {!loading && !err && rows.length === 0 && (
          <p className="py-10 text-center text-sm leading-relaxed text-neutral-600">
            {agent.name} 还没跟你说过话。
            <br />
            先打个招呼？
          </p>
        )}
        {rows.map((m, i) => {
          const prev = rows[i - 1];
          const mark = m.role === 'agent' && m.origin === 'proactive' && !(prev && prev.role === 'agent' && prev.origin === 'proactive');
          return <Bubble key={m.id} m={m} agent={agent} mark={mark} />;
        })}
        <div ref={bottom} />
      </div>

      <div className="sticky bottom-0 z-10 mt-4 border-t border-white/5 bg-ink/95 py-3 backdrop-blur">
        <div className="rounded-2xl border border-white/5 bg-card p-3 transition focus-within:border-white/15">
          <textarea
            className="sd-composer w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-neutral-600"
            placeholder={`跟 ${agent.name} 说点什么`}
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send();
            }}
          />
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="hidden text-xs text-neutral-700 sm:inline">Ctrl / ⌘ + Enter 发送</span>
            <span className="text-xs tabular-nums text-neutral-600">{text.length ? `${text.length}/2000` : ''}</span>
            <button
              className="rounded-lg bg-white/10 px-4 py-1.5 text-sm text-neutral-200 transition hover:bg-white/15 disabled:opacity-40"
              disabled={!text.trim() || sending}
              onClick={() => void send()}
            >
              {sending ? '说…' : '说给他听'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Bubble({ m, agent, mark }: { m: Row; agent: AgentMeta; mark: boolean }) {
  if (m.role === 'user')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-white/10 px-3.5 py-2 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-neutral-100">
          {m.text}
        </div>
      </div>
    );

  const typing = m.state === 'typing';
  const silent = !m.text && (m.state === 'pending' || typing);

  return (
    <div className="flex gap-2.5">
      <Avatar name={agent.name} accent={agent.accent} slug={agent.slug} className={`${mark ? 'mt-5' : 'mt-0.5'}`} />
      <div className="min-w-0 flex-1">
        {mark && <div className="mb-1 text-[11px] text-neutral-600">他主动来找你说</div>}
        {m.state === 'failed' ? (
          <p className="mt-1 text-xs leading-relaxed break-words text-rose-300/80">
            {m.error ?? '这次没说出来（生成失败）'}
            {m.createdAt ? <span className="ml-2 text-neutral-700">{timeAgo(m.createdAt)}</span> : null}
          </p>
        ) : silent ? (
          <Dots accent={agent.accent} label={typing ? '正在打字' : '还没说话'} className="mt-1.5" />
        ) : (
          <div
            className="max-w-[85%] rounded-2xl rounded-bl-md border border-white/5 px-3.5 py-2 text-[15px] leading-relaxed break-words whitespace-pre-wrap text-neutral-100"
            style={{ background: tint(agent.accent) }}
          >
            {m.text}
            {typing && <span className="sd-caret" style={{ background: lit(agent.accent) }} aria-hidden="true" />}
          </div>
        )}
      </div>
    </div>
  );
}
