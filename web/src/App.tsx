import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, sinceLastVisit, timeAgo, type AgentRow, type Digest, type Post, type ProactiveState } from './api';
import type { Notice } from './bits';
import { AgentRail, FriendStrip } from './Friends';
import { PostRail } from './Posts';
import Dm from './Dm';
import PostCard from './PostCard';

type Me = { id: number; handle: string };
type View = { kind: 'feed' } | { kind: 'dm'; slug: string };

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * 本地只存两样：「上次来看」（毫秒时间戳）和「别给我看了」。
 * 存不了（无痕模式 / 关掉本地存储）就当没有 —— 一个摘要不值得把整页搞挂。
 */
const SEEN_KEY = 'sd.lastSeen';
const OFF_KEY = 'sd.digestOff';
const readLocal = (k: string): string | null => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const writeLocal = (k: string, v: string): void => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* 存不了只影响这一条，不影响说话 */
  }
};

export default function App() {
  const [ready, setReady] = useState(false);
  const [boot, setBoot] = useState(0);
  const [offline, setOffline] = useState('');
  const [me, setMe] = useState<Me | null>(null);
  const [feed, setFeed] = useState<Post[]>([]);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  // 空着的时候这儿只是一行提示（一个空盒子不该占掉首屏小一半）；点一下才摊开成真的输入框。
  const [postOpen, setPostOpen] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [roster, setRoster] = useState<AgentRow[]>([]);
  const [rosterErr, setRosterErr] = useState('');
  const [adding, setAdding] = useState('');
  const [proactive, setProactive] = useState<ProactiveState | null>(null);
  const [proactiveErr, setProactiveErr] = useState('');
  const [view, setView] = useState<View>({ kind: 'feed' });
  const [dmSignal, setDmSignal] = useState(0);
  /** 大屏左栏选中哪一帖 —— 中栏一次只摊开一帖（窄屏没有左栏，就顺次全排）。 */
  const [selected, setSelected] = useState<number | null>(null);
  const [targetFloor, setTargetFloor] = useState<{ postId: number; floorId?: number } | null>(null);
  const [todayOpen, setTodayOpen] = useState(false);
  /** 「你不在的时候」——只在这页面第一次拿到 feed 时算一次，关了就一直不出现。 */
  const [digest, setDigest] = useState<Digest | null>(null);
  const digestDone = useRef(false);

  /**
   * 还有几条楼层没到 —— 只有 > 0 时才值得去叫 `/api/feed/tick`（页面不可见时也不叫）。
   * `pendingRef` 是给轮询里的异步回调读最新值的，免得把 pending 塞进依赖里反复重建定时器。
   */
  const [pending, setPending] = useState(0);
  const pendingRef = useRef(0);

  /** 洞里住着的人（含"加没加过好友"）。名录是这一栏唯一的来源。 */
  const loadRoster = useCallback(async () => {
    try {
      setRoster((await api.agents()).agents);
      setRosterErr('');
    } catch (e) {
      // 名录接口要是有毛病，至少把"我的吧友"要回来 —— 空屋子比半间屋子难看
      try {
        const { friends } = await api.friends();
        setRoster(friends.map((f) => ({ ...f, friend: true })));
        setRosterErr('');
      } catch {
        setRoster([]);
        setRosterErr(msg(e));
      }
    }
  }, []);

  const loadProactive = useCallback(async () => {
    try {
      setProactive(await api.proactive());
      setProactiveErr('');
    } catch (e) {
      // 这里失败是"服务端还没这个接口"，不是用户做错了什么 —— 角落里直说，不弹横幅
      setProactive(null);
      setProactiveErr(msg(e));
    }
  }, []);

  const openDm = useCallback(
    (slug: string) => {
      setView({ kind: 'dm', slug });
      setNotice(null);
      void loadRoster();
    },
    [loadRoster],
  );

  const addFriend = useCallback(async (slug: string, enter = false) => {
    setAdding(slug);
    try {
      const { friend } = await api.addFriend(slug);
      // 加完就住进来了：名录/头像条上立刻变成"聊两句"，不用等下次刷新
      setRoster((prev) => {
        const row: AgentRow = { ...friend, friend: true, unread: 0, lastText: null, lastAt: null };
        return prev.some((a) => a.slug === slug)
          ? prev.map((a) => (a.slug === slug ? { ...a, ...row } : a))
          : [row, ...prev];
      });
      if (enter) openDm(slug);
    } catch (e) {
      setNotice({ text: msg(e) });
    } finally {
      setAdding('');
    }
  }, []);

  const unfriend = useCallback(
    async (slug: string) => {
      const who = roster.find((a) => a.slug === slug)?.name ?? slug;
      if (!window.confirm(`不再和${who}来往？说过的话都还在。`)) return;
      try {
        await api.unfriend(slug);
      } catch (e) {
        setNotice({ text: `删不掉：${msg(e)}` });
        return;
      }
      // 他还是洞里的人（回帖照样会来），只是不再是我的好友
      setRoster((prev) =>
        prev.map((a) => (a.slug === slug ? { ...a, friend: false, unread: 0 } : a)),
      );
      setView({ kind: 'feed' });
    },
    [roster],
  );

  const toggleProactive = useCallback(async (enabled: boolean) => {
    try {
      setProactive(await api.setProactive(enabled));
    } catch (e) {
      setNotice({ text: msg(e) });
    }
  }, []);



  /** 以服务端为准重拉一遍（有人"没说出来"时，用它把 failed 状态同步过来）。 */
  const loadFeed = useCallback(async () => {
    const { posts } = await api.feed();
    setFeed(posts);
    // 只有"这次开页面的第一遍 feed"算回访摘要 —— 后面 tick 重拉不该改「上次来看」，否则摘要永远显示不出来
    if (!digestDone.current) {
      digestDone.current = true;
      const last = Number(readLocal(SEEN_KEY));
      if (last > 0 && readLocal(OFF_KEY) !== '1') {
        const d = sinceLastVisit(posts, last);
        if (d.said > 0) setDigest(d);
      }
      // 首次访问（没有记录）不弹这句话；但基线得记下，不然下次还是"首次"
      writeLocal(SEEN_KEY, String(Date.now()));
    }
    // 左栏选中的那帖要是没了（换了账号之类），就把最新的一帖摊开
    setSelected((prev) => (prev !== null && posts.some((p) => p.id === prev) ? prev : (posts[0]?.id ?? null)));
    const n = posts.reduce((acc, p) => acc + p.pending, 0);
    pendingRef.current = n;
    setPending(n);
  }, []);

  /**
   * 接一楼：这句话不花钱、也不会立刻有人回 —— 回你的排期在服务端，仍然靠 tick 一条条冒出来。
   * 发完先把它插进楼里（"你刚说的这句立刻在"），再以服务端为准重拉一遍（顺便把新排的回话算上）。
   */
  const replyFloor = useCallback(
    async (postId: number, content: string, noteId: number | null) => {
      const { floor } = await api.addFloor(postId, content, noteId);
      setFeed((prev) =>
        prev.map((p) => {
          if (p.id !== postId) return p;
          if (p.floors.some((f) => f.id === floor.id)) return p;
          return {
            ...p,
            floors: [
              ...p.floors,
              {
                id: floor.id,
                seq: floor.seq,
                kind: 'user' as const,
                slug: null,
                name: null,
                tagline: null,
                accent: null,
                content: floor.content,
                state: 'done',
                dueAt: null,
                at: floor.at,
                noteId,
              },
            ],
          };
        }),
      );
      // 接话会给"已经在这帖里说过话的吧友"排回话，重拉才知道该不该继续叫 tick
      void loadFeed().catch(() => {});
    },
    [loadFeed],
  );

  // 起手先问一句"我是谁"。这一步失败就是连不上服务端，不能假装成"没登录"。
  useEffect(() => {
    let dead = false;
    api
      .me()
      .then((r) => {
        if (!dead) setMe(r.user);
      })
      .catch((e: Error) => {
        if (!dead) setOffline(e.message);
      })
      .finally(() => {
        if (!dead) setReady(true);
      });
    return () => {
      dead = true;
    };
  }, [boot]);

  useEffect(() => {
    if (!me) return;
    void loadRoster();
    void loadProactive();
  }, [me, loadRoster, loadProactive]);

  useEffect(() => {
    if (!me) return;
    let dead = false;
    loadFeed().catch((e: Error) => {
      if (!dead) setNotice({ text: `拉不到你的帖子：${e.message}` });
    });
    return () => {
      dead = true;
    };
  }, [me, loadFeed]);

  /** 横幅按 Esc 就收起来 —— 它挡住了下面的东西。 */
  useEffect(() => {
    if (!notice) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setNotice(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notice]);

  /**
   * 吧友的回帖是一条一条到的：每隔几秒去叫一次 `/api/feed/tick`，每次最多带回来一位。
   * 页面不可见时一声不吭 —— 服务端不起定时器，没人在看就不该烧钱。
   */
  useEffect(() => {
    if (!me || pending === 0) return;
    let dead = false;
    const beat = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api.feedTick();
        if (dead) return;
        // tick 带回来的新楼层没有 id/seq —— 重拉一次才算真的落在它该在的楼号上。
        if (r.replies.length > 0) await loadFeed();
        if (r.error) setNotice({ text: r.error });
        // 正常一轮 = 在原来 pending 上减掉刚带回来的那几条；
        // 对不上说明有人"没说出来"（服务端已把它标成 failed），以服务端为准重拉一次。
        else {
          pendingRef.current = r.pending;
          setPending(r.pending);
        }
      } catch (e) {
        if (dead) return;
        // 429（撞成本闸门）或者掉登录：服务端原话给用户看，然后停手，别拿定时器砸它
        setNotice({ text: msg(e) });
        pendingRef.current = 0;
        setPending(0);
      }
    };
    void beat();
    const t = window.setInterval(() => void beat(), 6000);
    const onShow = () => {
      // 切回这个标签页立刻补一次，不用干等下一个 6 秒
      if (document.visibilityState === 'visible') void beat();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      dead = true;
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [me, pending, loadFeed]);

  /** 轮询要读最新的名录和当前视图，但不能因为它们变了就重开定时器 —— 用 ref 取。 */
  const rosterRef = useRef<AgentRow[]>([]);
  const viewRef = useRef<View>(view);
  useEffect(() => {
    rosterRef.current = roster;
  }, [roster]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);

  /**
   * 他会不会自己来找你：开着的时候每分钟问一次服务端。
   * 真来消息时 `messages[].text` 已经是成品、也已经落库，不用再开流。
   */
  useEffect(() => {
    if (!me || !proactive?.on || !proactive.enabled) return;
    let dead = false;
    const beat = async () => {
      try {
        const r = await api.tick();
        if (dead) return;
        setProactive(r);
        if (r.messages.length === 0) return;
        const v = viewRef.current;
        for (const m of r.messages) {
          const who = rosterRef.current.find((a) => a.slug === m.slug)?.name ?? m.slug;
          // 你正看着这条单聊，就别再弹一句"他来找你了"
          if (v.kind === 'dm' && v.slug === m.slug) continue;
          setNotice({
            text: `${who} 刚给你留了句话：「${m.text}」`,
            tone: 'info',
            retryLabel: '去看看',
            retry: () => openDm(m.slug),
          });
        }
        void loadRoster();
        setDmSignal((n) => n + 1);
      } catch (e) {
        if (!dead) setProactiveErr(msg(e));
      }
    };
    void beat();
    const t = window.setInterval(() => void beat(), 60_000);
    return () => {
      dead = true;
      window.clearInterval(t);
    };
  }, [me, proactive?.on, proactive?.enabled, loadRoster, openDm]);

  async function submit() {
    const content = text.trim();
    if (!content || sending || !me) return;
    setSending(true);
    setNotice(null);
    try {
      const { id, agents } = await api.createPost(content);
      setText('');
      setPostOpen(false);
      setFeed((prev) => [
        {
          id,
          content,
          created_at: Date.now(),
          handle: me.handle,
          author: { kind: 'user', handle: me.handle },
          pending: agents.length,
          floors: [],
        },
        ...prev,
      ]);
      // 刚贴的那帖摊开在眼前
      setSelected(id);
      setView({ kind: 'feed' });
      pendingRef.current += agents.length;
      setPending(pendingRef.current);
    } catch (e) {
      setNotice({ text: msg(e) });
    } finally {
      setSending(false);
    }
  }

  /** 关掉就一直不出现 —— 这是他自己选的，不给他再弹。 */
  function dismissDigest() {
    writeLocal(OFF_KEY, '1');
    setDigest(null);
  }

  async function logout() {
    try {
      await api.logout();
    } catch (e) {
      // 退不出去就别装作退出去了
      setNotice({ text: `退出失败：${msg(e)}` });
      return;
    }
    pendingRef.current = 0;
    setPending(0);
    setMe(null);
    setFeed([]);
    setRoster([]);
    setRosterErr('');
    setProactive(null);
    setProactiveErr('');
    setView({ kind: 'feed' });
    setNotice(null);
    setSelected(null);
    setDigest(null);
  }

  const friends = useMemo(() => roster.filter((a) => a.friend), [roster]);
  const friendSlugs = useMemo(() => new Set(friends.map((f) => f.slug)), [friends]);
  const dmAgent = view.kind === 'dm' ? roster.find((a) => a.slug === view.slug) : undefined;
  const todayItems = useMemo(() => {
    const items = feed.flatMap((p) => [
      { key: `p${p.id}`, postId: p.id, floorId: undefined as number | undefined, name: p.author.kind === 'agent' ? p.author.name : p.handle, text: p.content, at: p.created_at },
      ...p.floors.map((f) => ({ key: `f${f.id}`, postId: p.id, floorId: f.id, name: f.kind === 'agent' ? (f.name ?? f.slug ?? '有人') : '你', text: f.content, at: f.at ?? f.dueAt ?? p.created_at })),
    ]);
    return items.sort((a, b) => b.at - a.at).slice(0, 8);
  }, [feed]);
  if (!ready) return <div className="p-10 text-sm text-neutral-400">…</div>;
  if (!me && offline)
    return (
      <Offline
        message={offline}
        onRetry={() => {
          setOffline('');
          setReady(false);
          setBoot((b) => b + 1);
        }}
      />
    );
  if (!me) return <Auth onDone={setMe} />;

  return (
    <div className="mx-auto flex min-h-[100dvh] w-full max-w-[1400px] flex-col px-4 pb-20 sm:px-6 xl:px-8">
      <header className="flex items-start justify-between gap-4 border-b border-white/5 py-5 sm:py-6">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-[0.25em] text-neutral-200">述洞</h1>
          <p className="mt-1 text-xs text-neutral-400 sm:text-sm">说给洞里听，总会有人回你</p>
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5 text-sm">
          <span className="max-w-28 truncate text-neutral-400">{me.handle}</span>
          <button className="-mr-2 rounded px-2 py-1 text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100" onClick={() => void logout()}>
            退出
          </button>
        </div>
      </header>

      {notice && (
        <div
          className={`mt-5 flex items-start gap-3 rounded-xl border px-3 py-2.5 text-sm ${
            notice.tone === 'info'
              ? 'border-white/10 bg-white/5 text-neutral-200'
              : 'border-rose-500/20 bg-rose-500/5 text-rose-200'
          }`}
        >
          <span className="min-w-0 flex-1 leading-relaxed break-words">{notice.text}</span>
          {notice.retry && (
            <button
              className="shrink-0 rounded px-1.5 py-1 text-xs text-neutral-200 underline decoration-dotted underline-offset-2 transition hover:text-white"
              onClick={() => {
                const run = notice.retry;
                setNotice(null);
                run?.();
              }}
            >
              {notice.retryLabel ?? '重连'}
            </button>
          )}
          <button className="shrink-0 rounded px-1.5 py-1 text-xs text-neutral-200 transition hover:text-white" onClick={() => setNotice(null)}>
            知道了
          </button>
        </div>
      )}

      <div className="mt-7 grid flex-1 gap-8 lg:grid-cols-[minmax(0,1fr)_16rem] xl:grid-cols-[14rem_minmax(0,1fr)_18rem] xl:gap-10">
        <aside className="hidden xl:sticky xl:top-6 xl:h-[calc(100vh-3rem)] xl:block">
          <PostRail
            posts={feed}
            selected={selected}
            onSelect={(id) => {
              setSelected(id);
              setView({ kind: 'feed' });
              setNotice(null);
            }}
          />
        </aside>

        <main className="sd-wall min-w-0">
          {dmAgent ? (
            <Dm
              agent={dmAgent}
              onBack={() => setView({ kind: 'feed' })}
              onNotice={setNotice}
              onFriendsChanged={loadRoster}
              onUnfriend={() => void unfriend(dmAgent.slug)}
              signal={dmSignal}
            />
          ) : (
            <>
              <div className="mb-5 lg:hidden">
                <FriendStrip friends={friends} onOpen={openDm} />
              </div>

              <div className="mb-3 flex items-center justify-between">
                <span className="text-xs text-neutral-400">今天流</span>
                <button type="button" className="rounded px-2 py-1 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200" onClick={() => setTodayOpen((v) => !v)}>
                  {todayOpen ? '收起' : '打开'}
                </button>
              </div>
              {todayOpen && (
                <div className="mb-5 rounded-2xl border border-white/5 bg-card px-4 py-3 sm:px-5">
                  {todayItems.length === 0 ? (
                    <p className="text-sm text-neutral-400">今天还没有新话题。</p>
                  ) : (
                    <ul className="space-y-1">
                      {todayItems.map((it) => (
                        <li key={it.key}>
                          <button type="button" className="flex min-w-0 w-full items-baseline gap-2 rounded px-1.5 py-1 text-left text-xs transition hover:bg-white/5" onClick={() => { setSelected(it.postId); setTargetFloor({ postId: it.postId, floorId: it.floorId }); }}>
                            <span className="shrink-0 text-neutral-300">{it.name}</span>
                            <span className="min-w-0 flex-1 truncate text-neutral-400">{it.text}</span>
                            <span className="shrink-0 text-neutral-500">{timeAgo(it.at)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {postOpen ? (
                <div className="rounded-2xl border border-white/5 bg-card p-3 transition focus-within:border-white/12 sm:p-4">
                  <textarea
                    autoFocus
                    className="sd-composer w-full resize-none bg-transparent text-[15px] leading-relaxed outline-none placeholder:text-neutral-400"
                    placeholder="今天想说什么？"
                    maxLength={2000}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit();
                      // 什么都没写时按 Esc 就收回去（写了字不丢）。
                      if (e.key === 'Escape' && !text) setPostOpen(false);
                    }}
                  />
                  <div className="mt-2 flex items-center justify-between gap-3">
                    <span className="hidden text-xs text-neutral-400 sm:inline">Ctrl / ⌘ + Enter 发送</span>
                    <span className="text-xs tabular-nums text-neutral-400">
                      {text.length ? `${text.length}/2000` : ''}
                    </span>
                    <button
                      className="rounded-lg bg-white/10 px-4 py-1.5 text-sm text-neutral-200 transition hover:bg-white/15 disabled:opacity-40"
                      disabled={!text.trim() || sending}
                      onClick={() => void submit()}
                    >
                      {sending ? '贴上…' : '贴上去'}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  data-composer="closed"
                  aria-label="写一条新帖子"
                  className="w-full rounded-2xl border border-white/5 bg-card px-4 py-3 text-left text-[15px] text-neutral-400 transition hover:border-white/10 hover:bg-white/[0.02] sm:px-5"
                  onClick={() => setPostOpen(true)}
                >
                  今天想说什么？
                </button>
              )}

              {digest && (
                <div data-digest className="mb-5 rounded-2xl border border-white/5 bg-card px-4 py-3 sm:px-5">
                  <div className="flex items-start gap-2">
                    <p className="min-w-0 flex-1 text-sm leading-relaxed text-neutral-200">
                      你不在的时候，洞里有人说了 {digest.said} 句话
                    </p>
                    <button
                      type="button"
                      data-digest-close
                      aria-label="以后不再显示这个摘要"
                      title="以后不再显示"
                      className="-my-1 -mr-1 inline-flex min-h-7 min-w-7 shrink-0 items-center justify-center rounded text-base leading-none text-neutral-400 transition hover:bg-white/5 hover:text-neutral-100"
                      onClick={dismissDigest}
                    >
                      ×
                    </button>
                  </div>
                  <ul className="mt-2 space-y-0.5">
                    {digest.items.map((it) => (
                      <li key={it.key} className="min-w-0">
                        <button
                          type="button"
                          data-digest-item
                          className="flex min-h-7 w-full min-w-0 items-center gap-2 rounded px-1.5 text-left text-xs text-neutral-300 transition hover:bg-white/5 hover:text-neutral-100"
                          onClick={() => {
                            setSelected(it.postId);
                            setTargetFloor({ postId: it.postId, floorId: it.floorId });
                            setView({ kind: 'feed' });
                            setNotice(null);
                            setDigest(null);
                          }}
                        >
                          <span aria-hidden="true" className="shrink-0 text-neutral-400">
                            ·
                          </span>
                          <span className="min-w-0 flex-1 truncate">{it.text}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="mt-6 space-y-6">
                {feed.length === 0 && (
                  <div className="py-16 text-center text-sm leading-relaxed text-neutral-400">
                    洞里还很安静。
                    <br />
                    说点什么 —— 住在这儿的几个人会各自回你。
                  </div>
                )}
                {feed.map((p) => (
                  <div key={p.id} className={p.id === selected ? '' : 'xl:hidden'}>
                    <PostCard
                      post={p}
                      friends={friendSlugs}
                      waiting={p.pending > 0}
                      busy={adding}
                      onAdd={(slug) => void addFriend(slug, true)}
                      onOpen={openDm}
                       onReply={replyFloor}
                       targetFloorId={targetFloor?.postId === p.id ? targetFloor.floorId : undefined}
                     />
                  </div>
                ))}
              </div>
            </>
          )}
        </main>

        <aside className="hidden lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:block">
          <AgentRail
            agents={roster}
            err={rosterErr}
            busy={adding}
            proactive={proactive}
            proactiveErr={proactiveErr}
            onToggle={(v) => void toggleProactive(v)}
            onOpen={openDm}
            onAdd={(slug) => void addFriend(slug, true)}
          />
        </aside>
      </div>
    </div>
  );
}

function Offline({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-[0.25em]">述洞</h1>
      <p className="mt-3 text-sm leading-relaxed text-neutral-400">连不上服务器 —— {message}</p>
      <p className="mt-1 text-xs text-neutral-400">服务在 127.0.0.1:8787，本机起着吗？</p>
      <button
        className="mt-6 w-full rounded-lg bg-white/10 py-2 text-sm text-neutral-200 transition hover:bg-white/15"
        onClick={onRetry}
      >
        再试一次
      </button>
    </div>
  );
}

function Auth({ onDone }: { onDone: (me: Me) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function go() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const fn = mode === 'login' ? api.login : api.register;
      onDone(await fn(handle.trim(), password));
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-sm flex-col justify-center px-6">
      <h1 className="text-2xl font-semibold tracking-[0.25em]">述洞</h1>
      <p className="mt-2 text-sm leading-relaxed text-neutral-400">
        在这里说点不想让别人知道的话。洞里住着些人，他们性格各不相同，可能会回你。
      </p>
      <div className="mt-8 space-y-3">
        <input
          className="w-full rounded-lg border border-white/5 bg-card px-3 py-2 text-[15px] outline-none placeholder:text-neutral-400 focus:border-white/15"
          placeholder="网名"
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
        />
        <input
          className="w-full rounded-lg border border-white/5 bg-card px-3 py-2 text-[15px] outline-none placeholder:text-neutral-400 focus:border-white/15"
          placeholder="密码（至少 8 位）"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void go()}
        />
        {error && <p className="text-sm text-rose-300">{error}</p>}
        <button
          className="w-full rounded-lg bg-white/10 py-2 text-sm text-neutral-200 transition hover:bg-white/15 disabled:opacity-40"
          disabled={busy || !handle.trim() || password.length < 8}
          onClick={() => void go()}
        >
          {mode === 'login' ? '进去' : '开一个洞'}
        </button>
        <button
          className="w-full rounded py-1 text-xs text-neutral-400 transition hover:text-neutral-200"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError('');
          }}
        >
          {mode === 'login' ? '还没有网名？注册一个' : '已经有账号？去登录'}
        </button>
      </div>
    </div>
  );
}
