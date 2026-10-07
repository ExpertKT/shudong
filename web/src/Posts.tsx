import { dayLabel, timeAgo, type Post } from './api';
import { Avatar, SectionLabel, lit } from './bits';

/** 楼主 + 已经说出口的楼层 = 这一帖现在有多少楼（服务端只给 `state='done'` 的楼层）。 */
const floorCount = (p: Post) => 1 + p.floors.length;

/** 最后开口的那位吧友：列表行右边那个小头像，一眼看出"谁刚接过话"。 */
const lastSpeaker = (p: Post) => {
  const said = p.floors.filter((f) => f.kind === 'agent' && f.name);
  const last = said[said.length - 1];
  return last ? { name: last.name as string, accent: last.accent ?? '#8b94a3', slug: last.slug ?? null } : null;
};

/**
 * 左栏：洞里的帖子。按天分组，一行一帖 —— 这就是"我的洞"的目录。
 * 大屏上它负责换帖（中栏一次只摊开一帖），窄屏整栏藏掉，帖子在中栏顺次往下排。
 */
export function PostRail({
  posts,
  selected,
  onSelect,
}: {
  posts: Post[];
  selected: number | null;
  onSelect: (id: number) => void;
}) {
  const groups: { label: string; posts: Post[] }[] = [];
  for (const p of posts) {
    const label = dayLabel(p.created_at);
    const g = groups[groups.length - 1];
    if (g && g.label === label) g.posts.push(p);
    else groups.push({ label, posts: [p] });
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto rounded-2xl border border-white/5 bg-card p-3">
      <div className="flex items-baseline justify-between px-1 pb-3">
        <SectionLabel>洞里的帖子</SectionLabel>
        <span className="text-xs tabular-nums text-neutral-400">{posts.length}</span>
      </div>

      {posts.length === 0 && (
        <p className="px-1 text-xs leading-relaxed text-neutral-400">
          还没贴过什么。
          <br />
          右边写第一句，这里就会有一行。
        </p>
      )}

      {groups.map((g) => (
        <div key={g.label} className="mb-5">
          <div className="px-1 pb-1.5 text-xs text-neutral-400">{g.label}</div>
          <ul className="space-y-0.5">
            {g.posts.map((p) => {
              const mine = p.id === selected;
              const who = lastSpeaker(p);
              return (
                <li key={p.id}>
                  <button
                    aria-current={mine ? 'true' : undefined}
                    className={`relative block w-full rounded-lg px-2.5 py-2 text-left transition ${
                      mine ? 'bg-white/[0.045]' : 'hover:bg-white/[0.025]'
                    }`}
                    onClick={() => onSelect(p.id)}
                  >
                    <span
                      className={`absolute top-2.5 bottom-2.5 left-0 w-px ${mine ? 'bg-white/25' : 'bg-transparent'}`}
                      aria-hidden="true"
                    />
                    <span
                      className={`line-clamp-2 text-[13px] leading-5 break-words ${
                        mine ? 'text-neutral-200' : 'text-neutral-400'
                      }`}
                    >
                      {p.content}
                    </span>
                    <span className="mt-1.5 flex items-center gap-2 text-xs tabular-nums text-neutral-400">
                      {p.author.kind === 'agent' && (
                        <>
                          <span className="min-w-0 truncate font-medium" style={{ color: lit(p.author.accent) }}>
                            {p.author.name}
                          </span>
                          <span>·</span>
                        </>
                      )}
                      <span>{floorCount(p)} 楼</span>
                      <span>·</span>
                      <span>{timeAgo(p.created_at)}</span>
                      {who && (
                        <span className="ml-auto">
                          <Avatar name={who.name} accent={who.accent} slug={who.slug} />
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}
