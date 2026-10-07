import { useEffect, useState } from 'react';
import { timeAgo, type Floor as FloorData, type Post } from './api';
import { Avatar, chisel, lit } from './bits';

/** 你自己接的那一楼没有 accent，也不该有"加好友/聊两句"。 */
const NEUTRAL = '#8b94a3';

/**
 * 洞壁那一竖，加上这一楼的凿痕。
 * 每楼各接一段，连起来就是整面墙；凿痕只标两件事：这楼是谁说的、他是从墙里往这边说的。
 * 你自己说的话（楼主和你接的楼）钉的是壁上那根亮一点的横钉 —— 一眼就认出来，不用气泡。
 */
function Groove({ accent, pin = false, last = false }: { accent?: string; pin?: boolean; last?: boolean }) {
  return (
    <span className="relative w-4 shrink-0" aria-hidden="true">
      <span
        className={`absolute inset-y-0 left-0 w-px ${
          last ? 'bg-gradient-to-b from-white/[0.07] to-transparent' : 'bg-white/[0.07]'
        }`}
      />
      {pin ? (
        <span className="absolute top-2 left-0 h-4 w-px bg-white/20" />
      ) : (
        <span className="absolute top-3 left-0 h-px w-4" style={{ background: chisel(accent ?? '#ffffff') }} />
      )}
    </span>
  );
}

/**
 * 接话的输入框：点开才有，Escape 收起来，Ctrl/⌘ + Enter 发。
 * 服务端说什么就显示什么（"最多 2000 字"…）—— 这句不能咽掉。
 */
function Composer({
  placeholder,
  onSend,
  onCancel,
}: {
  placeholder: string;
  onSend: (content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const go = async () => {
    const v = text.trim();
    if (!v || busy) return;
    setBusy(true);
    setErr('');
    try {
      await onSend(v);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <textarea
        autoFocus
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void go();
          }
        }}
        placeholder={placeholder}
        className="w-full resize-none rounded-xl border border-white/5 bg-white/[0.03] px-3 py-2 text-[15px] leading-[1.7] break-words text-neutral-200 outline-none transition focus:border-white/10 placeholder:text-neutral-400"
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          disabled={busy || !text.trim()}
          onClick={() => void go()}
          className="-ml-2 inline-flex min-h-6 items-center rounded px-2 text-xs font-medium text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100 disabled:opacity-40"
        >
          {busy ? '说着…' : '就这句'}
        </button>
        <button onClick={onCancel} className="inline-flex min-h-6 items-center rounded px-2 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200">
          算了
        </button>
        <span className="hidden text-xs text-neutral-400 sm:inline">Ctrl / ⌘ + Enter</span>
        {/* 服务端原话单独一行 —— 窄屏上它跟按钮挤在一行会念不成句 */}
        {err && <span className="w-full text-xs leading-relaxed break-words text-rose-300">{err}</span>}
      </div>
    </div>
  );
}

/** 不点开的时候，一楼底下只有这一行很淡的小字 —— 想接就接，不抢楼层本身的注意力。 */
function ReplyEntry({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      aria-label={label}
      onClick={onClick}
      className="-ml-1.5 mt-2 inline-flex min-h-11 items-center rounded px-2 text-xs leading-5 text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100"
    >
      接一句
    </button>
  );
}

/**
 * 一楼。楼号、凿痕、人、话 —— 一条条落下来，不吐字。
 * 只有真的说出口了的楼层才会被服务端给到：没到的人不占位、不预告、不转圈。
 */
function FloorRow({
  floor,
  last,
  friend,
  busy,
  replyOpen,
  onToggleReply,
  onReply,
  onAdd,
  onOpen,
}: {
  floor: FloorData;
  last: boolean;
  friend: boolean;
  busy: boolean;
  replyOpen: boolean;
  onToggleReply: () => void;
  onReply: (content: string) => Promise<void>;
  onAdd: (slug: string) => void;
  onOpen: (slug: string) => void;
}) {
  const mine = floor.kind === 'user' || !floor.slug;
  const accent = floor.accent ?? NEUTRAL;
  const name = mine ? '你' : (floor.name ?? floor.slug ?? '');
  return (
    <li data-floor-id={floor.id} className={`flex gap-3 ${last ? '' : 'pb-6'}`}>
      <span
        className={`w-7 shrink-0 pt-0.5 text-right text-xs tabular-nums ${
          mine ? 'text-neutral-300' : 'text-neutral-400'
        }`}
      >
        {floor.seq} 楼
      </span>
      <Groove accent={mine ? undefined : accent} pin={mine} last={last} />
      {/* 接在哪一楼下面：往右让一格、加一道更浅的竖痕 —— 不画线、不画箭头。 */}
      <div className={`flex min-w-0 flex-1 gap-3 ${floor.noteId ? 'border-l border-white/10 pl-5' : ''}`}>
        <Avatar name={name} accent={accent} slug={floor.slug} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className={`min-w-0 truncate text-sm font-medium ${mine ? 'text-neutral-300' : ''}`}
              style={mine ? undefined : { color: lit(accent) }}
            >
              {name}
            </span>
            <span className="max-sm:hidden min-w-0 flex-1 truncate text-xs text-neutral-400">{floor.tagline ?? ''}</span>
            {!mine &&
              floor.slug &&
              (friend ? (
                <button
                  className="-my-1 inline-flex min-h-6 shrink-0 items-center rounded px-1.5 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
                  onClick={() => onOpen(floor.slug as string)}
                >
                  聊两句
                </button>
              ) : (
                <button
                  className="-my-1 inline-flex min-h-6 shrink-0 items-center rounded px-1.5 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200 disabled:opacity-40"
                  disabled={busy}
                  onClick={() => onAdd(floor.slug as string)}
                >
                  {busy ? '…' : '+ 加好友'}
                </button>
              ))}
          </div>
          <p className="mt-2 max-w-[38rem] text-[15px] leading-[1.75] break-words whitespace-pre-wrap text-neutral-300">
            {floor.content}
          </p>
          {replyOpen ? (
            <Composer
              placeholder={mine ? '再往下说一句' : `接 ${name} 这句`}
              onSend={onReply}
              onCancel={onToggleReply}
            />
          ) : (
            <ReplyEntry label={mine ? '接你自己这一楼' : `接 ${name} 这句`} onClick={onToggleReply} />
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * 一帖 = 一栋楼：楼主钉在壁上，吧友的话顺着那道凿痕一层层往里说。
 * 一条帖子从头到尾就一个圆角盒子（壁上的一块），楼与楼之间只靠墙上的脊、凿痕和留白分开 —— 不是一条条对话气泡。
 */
// 长楼先折起来：一屏读得完，剩下的收在「展开」后面（信息一条都不删，点一下就全在）。
// 头 HEAD 楼 + 尾 TAIL 楼 —— 尾巴留的是最新的几楼，通常就有自己刚接的那一楼。
const FOLD_AT = 8;
const HEAD = 6;
const TAIL = 3;

export default function PostCard({
  post,
  friends,
  busy,
  waiting,
  onAdd,
  onOpen,
  onReply,
  targetFloorId,
}: {
  post: Post;
  /** 已经住进来的吧友（slug）。加过的人就不再显示「加好友」。 */
  friends: Set<string>;
  /** 正在加的那个 slug。 */
  busy: string;
  /** 我们是不是还在等他回（打不通就停手了，那就不该继续装作有人在听）。 */
  waiting: boolean;
  onAdd: (slug: string) => void;
  onOpen: (slug: string) => void;
  /** 接一楼。`noteId` 是接的那一楼，接楼主传 null。 */
  onReply: (postId: number, content: string, noteId: number | null) => Promise<void>;
  targetFloorId?: number;
}) {
  // 楼号一律用服务端给的 `seq`（1 楼永远是楼主），不按下标编 —— 有楼层没说出来时下标会错位。
  // 服务端通常已按 seq 排序；这里再守一次契约，避免轮询/乐观插入改变楼号顺序。
  const landed = [...post.floors].sort((a, b) => a.seq - b.seq);
  const quiet = landed.length === 0 && waiting;
  // 折叠：只在长楼生效。默认折着 —— 楼是往下长的，先给你开头和最新那几句。
  const long = landed.length > FOLD_AT;
  const [expanded, setExpanded] = useState(false);
  const open = expanded || !long;
  const head = open ? landed : landed.slice(0, HEAD);
  const tail = open ? [] : landed.slice(-TAIL);
  const hidden = landed.length - head.length - tail.length;
  const author = post.author;
  // 同一时刻只开一个输入框：'lord' 是接楼主，数字是接那一楼。
  const [openNote, setOpenNote] = useState<'lord' | number | null>(null);
  useEffect(() => {
    if (targetFloorId == null || !landed.some((f) => f.id === targetFloorId)) return;
    setExpanded(true);
    window.setTimeout(() => {
      document.querySelector(`[data-floor-id="${targetFloorId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 0);
  }, [targetFloorId]);
  const toggle = (k: 'lord' | number) => setOpenNote((prev) => (prev === k ? null : k));
  const sendTo = (noteId: number | null) => async (content: string) => {
    await onReply(post.id, content, noteId);
    setOpenNote(null);
  };

  return (
    <article className="sd-in rounded-2xl border border-white/5 bg-card p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)] sm:p-6">
      <div className="flex gap-3">
        <span className="w-7 shrink-0 pt-1 text-right text-xs tabular-nums text-neutral-400">1 楼</span>
        <Groove accent={author.kind === 'agent' ? author.accent : undefined} pin={author.kind === 'user'} />
        <div className="min-w-0 flex-1">
          <p className="max-w-[38rem] text-[17px] leading-[1.85] break-words whitespace-pre-wrap text-neutral-100">
            {post.content}
          </p>
          {author.kind === 'agent' ? (
            /* 吧友自己起的话头：走吧友那套（头像 + 他自己那一色 + 签名），跟"你发的"一眼分得开。 */
            <div data-lord="agent" className="mt-3 flex min-w-0 items-center gap-2 text-xs leading-5 tabular-nums text-neutral-400">
              <Avatar name={author.name} accent={author.accent} slug={author.slug} />
              <span className="min-w-0 truncate text-sm font-medium" style={{ color: lit(author.accent) }}>
                {author.name}
              </span>
              <span className="max-sm:hidden min-w-0 flex-1 truncate">{author.tagline}</span>
              <span className="shrink-0">·</span>
              <span className="shrink-0">{timeAgo(post.created_at)}</span>
              {friends.has(author.slug) ? (
                <button
                  className="-my-1 inline-flex min-h-6 shrink-0 items-center rounded px-1.5 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200"
                  onClick={() => onOpen(author.slug)}
                >
                  聊两句
                </button>
              ) : (
                <button
                  className="-my-1 inline-flex min-h-6 shrink-0 items-center rounded px-1.5 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200 disabled:opacity-40"
                  disabled={busy === author.slug}
                  onClick={() => onAdd(author.slug)}
                >
                  {busy === author.slug ? '…' : '+ 加好友'}
                </button>
              )}
            </div>
          ) : (
            <div data-lord="user" className="mt-3 flex min-w-0 items-center gap-2 text-xs leading-5 tabular-nums text-neutral-400">
              <span>楼主 · {author.handle}</span>
              <span>·</span>
              <span>{timeAgo(post.created_at)}</span>
            </div>
          )}
          {openNote === 'lord' ? (
            <Composer placeholder="接着往下说一句" onSend={sendTo(null)} onCancel={() => toggle('lord')} />
          ) : (
            <ReplyEntry label="接楼主这一楼" onClick={() => toggle('lord')} />
          )}
        </div>
      </div>

      {landed.length > 0 && (
        <ul id={`post-floors-${post.id}`} className="mt-6 border-t border-white/5 pt-6" aria-live="polite">
          {head.map((f, i) => (
            <FloorRow
              key={f.id}
              floor={f}
              last={open && i === head.length - 1}
              friend={!!f.slug && friends.has(f.slug)}
              busy={!!f.slug && busy === f.slug}
              replyOpen={openNote === f.id}
              onToggleReply={() => toggle(f.id)}
              onReply={sendTo(f.id)}
              onAdd={onAdd}
              onOpen={onOpen}
            />
          ))}
          {hidden > 0 && (
            <li data-fold="row" className="flex gap-3 pb-6">
              <span className="w-7 shrink-0" aria-hidden="true" />
              <span className="relative w-4 shrink-0" aria-hidden="true">
                <span className="absolute inset-y-0 left-0 w-px bg-gradient-to-b from-white/[0.07] to-transparent" />
              </span>
              <button
                type="button"
                data-fold="open"
                 aria-expanded={false}
                 aria-controls={`post-floors-${post.id}`}
                className="-ml-1.5 mt-2 inline-flex min-h-11 min-w-11 items-center rounded px-2 text-xs leading-5 text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100"
                onClick={() => setExpanded(true)}
              >
                中间还有 {hidden} 楼 · 展开
              </button>
            </li>
          )}
          {tail.map((f, i) => (
            <FloorRow
              key={f.id}
              floor={f}
              last={i === tail.length - 1}
              friend={!!f.slug && friends.has(f.slug)}
              busy={!!f.slug && busy === f.slug}
              replyOpen={openNote === f.id}
              onToggleReply={() => toggle(f.id)}
              onReply={sendTo(f.id)}
              onAdd={onAdd}
              onOpen={onOpen}
            />
          ))}
          {open && long && (
            <li data-fold="row" className="flex gap-3">
              <span className="w-7 shrink-0" aria-hidden="true" />
              <span className="relative w-4 shrink-0" aria-hidden="true" />
              <button
                type="button"
                data-fold="close"
                 aria-expanded={true}
                 aria-controls={`post-floors-${post.id}`}
                className="-ml-1.5 mt-2 inline-flex min-h-11 min-w-11 items-center rounded px-2 text-xs leading-5 text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100"
                onClick={() => setExpanded(false)}
              >
                收起
              </button>
            </li>
          )}
        </ul>
      )}

      {/* 极轻的一句：不说是谁、不转圈、不排队 —— 只是"有人在看"。 */}
      {quiet && (
        <p
          role="status"
          aria-live="polite"
          className="mt-6 flex items-center gap-2 pl-17 text-[13px] leading-relaxed text-neutral-300"
        >
          <span>洞里有人听见了。</span>
          <span className="sd-caret" aria-hidden="true" />
        </p>
      )}
    </article>
  );
}
