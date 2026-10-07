export type AgentMeta = { slug: string; name: string; tagline: string; accent: string };

/**
 * 一栋楼里的一层。`kind:'user'` 是你自己接的话（没有 slug/accent，名字就是你），`kind:'agent'` 是吧友。
 * `dueAt` = 计划到点时刻，`at` = 真实开口时刻 —— 楼层排序看 `seq`（服务端给的），别按下标编。
 */
export type Floor = {
  id: number;
  seq: number;
  kind: 'user' | 'agent';
  slug: string | null;
  name: string | null;
  tagline: string | null;
  accent: string | null;
  content: string;
  state: string;
  dueAt?: number | null;
  at?: number | null;
  /** 接的是哪一楼（接楼主就是 null）—— 楼中楼靠它。 */
  noteId?: number | null;
};

/** 楼主是你（`kind:'user'`，有 handle），还是某位吧友（他自己起的话头）。 */
export type Author =
  | { kind: 'user'; handle: string }
  | { kind: 'agent'; slug: string; name: string; tagline: string; accent: string };

export type Post = {
  id: number;
  content: string;
  created_at: number;
  handle: string;
  author: Author;
  /** 还没开口的人数 —— 只用来决定"还要不要继续叫 tick"，不许渲染成人/头像/转圈。 */
  pending: number;
  /** 只说出口了的楼层，服务端已按 `seq` 排好。 */
  floors: Floor[];
};

/** SSE 的事件形状 —— 现在只剩单聊在用了（帖子改走 `POST /api/feed/tick` 轮询）。 */
export type Evt = { type: string; slug?: string; id?: number; text?: string; message?: string };

/** tick 带回来的一条楼层：text 已经是成品，也已经落库（但它没有 id/seq，重拉 `/api/feed` 才是真的楼号）。 */
export type FeedReply = { postId: number; slug: string; name: string; text: string; at: number };

/** "你不在的时候"该说什么：比"上次来看"新的吧友发言。分不清新旧的一律算旧 —— 宁可少报。 */
export type Digest = { said: number; items: { key: string; text: string; postId: number; floorId?: number }[] };

/** 最多列几条要点。 */
const DIGEST_ITEMS = 3;

/**
 * 拿整份 feed 跟"上次来看"比：楼层看 `at`、帖子看 `created_at`，比它新才算新。
 * 只用服务端已经给了的字段（`author.kind`/`created_at`/`seq`/`at`/`noteId`），不猜也不补 —— 看不出来就少报一条。
 */
export function sinceLastVisit(posts: Post[], since: number): Digest {
  type Item = { key: string; text: string; postId: number; floorId?: number; at: number };
  const toMe: Item[] = [];
  const threads: Item[] = [];
  let said = 0;
  for (const p of posts) {
    const fresh = p.floors.filter((f) => f.kind === 'agent' && f.at != null && f.at > since);
    const born = p.author.kind === 'agent' && p.created_at > since;
    // 新楼自己那句也算一句；它下面要是也有新落楼，就别重复数（少报不算错报）
    said += fresh.length + (born && fresh.length === 0 ? 1 : 0);
    for (const f of fresh) {
      const who = f.name ?? f.slug ?? '有人';
      const at = f.at as number;
      const to = f.noteId == null ? undefined : p.floors.find((x) => x.id === f.noteId);
      if (to?.kind === 'user') toMe.push({ key: `f${f.id}`, text: `${who} 回了你 ${to.seq} 楼`, postId: p.id, floorId: f.id, at });
      // 接楼主就是接这栋楼的楼主：只有这帖是我发的，才敢说"回了你的帖"
      else if (p.author.kind === 'user') toMe.push({ key: `f${f.id}`, text: `${who} 回了你的帖`, postId: p.id, at });
    }
    if (born && p.author.kind === 'agent') threads.push({ key: `p${p.id}`, text: `${p.author.name} 起了个话头`, postId: p.id, at: p.created_at });
  }
  const newest = (a: Item, b: Item) => b.at - a.at;
  // "回了你"比"别人起的话头"更该先看见；每组里新的先露头。数不出来（>0 却没要点）就只报数，宁缺勿编。
  const items = [...toMe.sort(newest), ...threads.sort(newest)]
    .slice(0, DIGEST_ITEMS)
    .map(({ key, text, postId, floorId }) => ({ key, text, postId, ...(floorId === undefined ? {} : { floorId }) }));
  return { said, items };
}

/** 加了好友才进得去单聊 —— 好友关系是权限，不是装饰。 */
export type Friend = AgentMeta & {
  since: number;
  lastText: string | null;
  lastAt: number | null;
  unread: number;
};

/** `GET /api/agents` 的一行：洞里常住的吧友，以及"我跟他什么关系"。名录和侧栏都吃它。 */
export type AgentRow = AgentMeta & {
  friend: boolean;
  unread: number;
  lastText: string | null;
  lastAt: number | null;
};

export type DmMessage = {
  id: number;
  role: 'user' | 'agent';
  text: string | null;
  state: 'pending' | 'done' | 'failed';
  seen: boolean;
  createdAt: number;
  origin: 'reply' | 'proactive';
};

export type DmThread = { agent: AgentMeta; friend: true; impression: string | null; messages: DmMessage[] };

export type ProactiveState = {
  on: boolean;
  enabled: boolean;
  sentToday: number;
  dailyMax: number;
  minGapMin: number;
};

/** tick 的返回：至多一条，text 已经是成品（也已落库、未读已 +1），不用再开流。 */
export type ProactiveTick = ProactiveState & { messages: { slug: string; id: number; text: string }[] };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const error = body.error;
    const message =
      typeof error === 'string'
        ? error
        : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
          ? error.message
          : `请求失败 ${res.status}`;
    throw new Error(message);
  }
  return body as T;
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const api = {
  me: () => req<{ user: { id: number; handle: string } | null }>('/api/me'),
  login: (handle: string, password: string) =>
    req<{ id: number; handle: string }>('/api/auth/login', post({ handle, password })),
  register: (handle: string, password: string) =>
    req<{ id: number; handle: string }>('/api/auth/register', post({ handle, password })),
  logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  feed: () => req<{ posts: Post[] }>('/api/feed'),
  /** 发帖那刻"谁来回、什么时候来"就定死了，所以这里带着 `dueAt` 回来（人数 = 之后会有几楼）。 */
  createPost: (content: string) =>
    req<{ id: number; agents: (AgentMeta & { dueAt: number })[] }>('/api/posts', post({ content })),
  /**
   * 在任何一楼下面接话。这句话本身不花钱、也不会立刻有人回 —— 回你的排期在服务端，仍然走 tick。
   * `noteId` 是你接的那一楼（接楼主就不传）。
   */
  addFloor: (postId: number, content: string, noteId?: number | null) =>
    req<{ floor: { id: number; seq: number; kind: 'user'; content: string; at: number } }>(
      `/api/posts/${postId}/floors`,
      post(noteId === undefined || noteId === null ? { content } : { content, noteId }),
    ),
  /**
   * 回帖是一条一条到的：每隔几秒问一次，每次最多带回来一位。
   * 429（撞成本闸门）会抛，`error` 是服务端原话；200 里的 `error` 是"这条生成失败了"。
   */
  feedTick: () => req<{ replies: FeedReply[]; pending: number; error?: string }>('/api/feed/tick', { method: 'POST' }),

  /** 洞里常住的吧友名录（回帖人不限于好友，所以它不等于"我的好友"）。 */
  agents: () => req<{ agents: AgentRow[] }>('/api/agents'),
  friends: () => req<{ friends: Friend[] }>('/api/friends'),
  addFriend: (slug: string) => req<{ ok: true; friend: AgentMeta }>('/api/friends', post({ slug })),
  unfriend: (slug: string) => req<{ ok: true }>(`/api/friends/${encodeURIComponent(slug)}`, { method: 'DELETE' }),
  dm: (slug: string, limit = 50) => req<DmThread>(`/api/dm/${encodeURIComponent(slug)}?limit=${limit}`),
  sendDm: (slug: string, text: string) =>
    req<{ ok: true; userMessageId: number; agentMessageId: number }>(
      `/api/dm/${encodeURIComponent(slug)}`,
      post({ text }),
    ),
  seenDm: (slug: string) => req<{ ok: true }>(`/api/dm/${encodeURIComponent(slug)}/seen`, { method: 'POST' }),

  proactive: () => req<ProactiveState>('/api/proactive'),
  setProactive: (enabled: boolean) =>
    req<ProactiveState>('/api/proactive', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  tick: () => req<ProactiveTick>('/api/proactive/tick', { method: 'POST' }),
};

/**
 * 单聊的 SSE 读取器（帖子的流已经没了，改走 `api.feedTick`）。
 * 返回一个关闭函数 —— 调用方必须在卸载/换人时调用，否则浏览器会自己重连。
 */
export function sse(path: string, on: { event: (evt: Evt) => void; error: () => void }): () => void {
  const es = new EventSource(path);
  es.onmessage = (e) => {
    let evt: Evt;
    try {
      evt = JSON.parse(e.data) as Evt;
    } catch {
      return; // 注释行/心跳，不是 JSON
    }
    if (evt.type === 'ping') return;
    on.event(evt);
  };
  // 以前这里是静默 close：401（登录过期）/ 404 / 服务重启，界面上永远是三个点
  es.onerror = () => on.error();
  return () => es.close();
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return '刚刚';
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** 我的帖子列表按天分组时要的"这是哪一天" —— 今天 / 昨天 / 10 月 3 日。 */
export function dayLabel(ts: number): string {
  const at = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((at(new Date()) - at(new Date(ts))) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  const d = new Date(ts);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}
