import { timeAgo, type AgentRow, type ProactiveState } from './api';
import { Avatar, SectionLabel, glow, lit, tint } from './bits';

/** 未读小红点。这是"他找过你"唯一的信号，必须看得见。 */
function Unread({ n, className = '' }: { n: number; className?: string }) {
  return (
    <span
      className={`flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500/90 px-1 text-[10px] leading-none font-medium text-white ${className}`}
      aria-label={`${n} 条没看`}
    >
      {n > 9 ? '9+' : n}
    </span>
  );
}

/** "至少隔 12 小时" —— 把服务端的分钟数说成人话。 */
const gapText = (min: number) =>
  min <= 0 ? '' : min % 60 === 0 ? `，至少隔 ${min / 60} 小时` : `，至少隔 ${min} 分钟`;

/**
 * 主动来消息的开关。`on` 是服务端总闸（部署时定死），关着的时候这个开关点了也没用 —— 那就直说。
 * 它是**全局**的一个设置（不是某个吧友的），所以只住在"好友/私聊"这一栏的最底下，不往吧里摆。
 */
export function ProactiveSwitch({
  state,
  err = '',
  onToggle,
}: {
  /** null = 服务端没这个接口（比如还没重启到新版本）。那就直说，别装作这是个能用的开关。 */
  state: ProactiveState | null;
  err?: string;
  onToggle: (enabled: boolean) => void;
}) {
  if (!state)
    return (
      <div className="mt-3 border-t border-white/5 px-1 pt-3">
        <div className="text-xs text-neutral-400">他会自己来找我</div>
        <p className="mt-1 text-xs leading-relaxed text-neutral-400">
          {err ? `现在用不了 —— ${err}` : '服务端还没这个开关。'}
        </p>
      </div>
    );

  const note = !state.on
    ? '服务端那边关着，现在没人会主动找你。'
    : state.enabled
      ? `今天来过 ${state.sentToday}/${state.dailyMax} 条${gapText(state.minGapMin)}`
      : '关着的时候，就没人会自己来找你。';

  return (
    <div className="mt-3 border-t border-white/5 px-1 pt-3">
      <label className="-mx-2 flex cursor-pointer items-center justify-between gap-3 rounded px-2 py-1">
        <span className="text-xs text-neutral-400">他会自己来找我</span>
        <input
          type="checkbox"
          className="peer sr-only"
          checked={state.enabled}
          disabled={!state.on}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <span className="relative h-4 w-7 shrink-0 rounded-full bg-white/10 transition peer-checked:bg-white/25 peer-focus-visible:ring-2 peer-focus-visible:ring-white/20 peer-disabled:opacity-40 after:absolute after:top-0.5 after:left-0.5 after:h-3 after:w-3 after:rounded-full after:bg-white/80 after:transition peer-checked:after:translate-x-3" />
      </label>
      <p className="mt-1 text-xs leading-relaxed text-neutral-400">{note}</p>
    </div>
  );
}

/** 窄屏：一排头像。放得下、不占地方，也不横向撑破页面。 */
export function FriendStrip({ friends, onOpen }: { friends: AgentRow[]; onOpen: (slug: string) => void }) {
  if (friends.length === 0) return null;
  return (
    <div>
      <SectionLabel className="mb-2">我的吧友</SectionLabel>
      <div className="flex gap-3 overflow-x-auto pb-1">
        {friends.map((f) => (
          <button key={f.slug} className="flex w-14 shrink-0 flex-col items-center gap-1" onClick={() => onOpen(f.slug)}>
            <span className="relative">
              <Avatar name={f.name} accent={f.accent} slug={f.slug} size="list" />
              {f.unread > 0 && <Unread n={f.unread} className="absolute -top-1 -right-1" />}
            </span>
            <span className="w-full truncate text-center text-xs text-neutral-400">{f.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * 右栏：洞里住着的人。一行一个人，扫一眼就要能看出两件事 ——
 * 他上次跟你说了什么（有未读的话那一行会被他自己那一色淡淡托起来、说的那句也提亮），
 * 以及"我跟他什么关系"（已经是好友的整行都能点进去，没加过的才有一个「加好友」）。
 * 头像外面那圈微光是"壁上的光点"：同一个 accent，只往外散一点，不新添颜色。
 * 这一栏是**通高**的：名录在上面，那个全局开关被压在最底下（它不属于某个人，也不属于吧里）。
 */
export function AgentRail({
  agents,
  err,
  busy,
  proactive,
  proactiveErr,
  onToggle,
  onOpen,
  onAdd,
}: {
  agents: AgentRow[];
  /** 名录拉不到时的那句话（比如服务端还没重启到新版本）。 */
  err: string;
  busy: string;
  proactive: ProactiveState | null;
  proactiveErr: string;
  onToggle: (enabled: boolean) => void;
  onOpen: (slug: string) => void;
  onAdd: (slug: string) => void;
}) {
  return (
    <div className="flex h-full flex-col rounded-2xl border border-white/5 bg-card p-3">
      <div className="flex items-baseline justify-between px-2 pb-2">
        <SectionLabel>洞里住着的人</SectionLabel>
        <span className="text-xs tabular-nums text-neutral-400">{agents.length}</span>
      </div>

      {agents.length === 0 ? (
        <p className="px-2 py-1 text-xs leading-relaxed text-neutral-400">
          {err ? `名录拉不到 —— ${err}` : '洞里还没有人。'}
        </p>
      ) : (
        <ul className="min-h-0 overflow-y-auto pb-1">
          {agents.map((a) => {
            const hot = a.unread > 0;
            const row = (
              <>
                <span className="relative mt-0.5 shrink-0">
                  <Avatar name={a.name} accent={a.accent} slug={a.slug} size="list" />
                  <span
                    className="absolute inset-0 rounded-full"
                    style={{ boxShadow: glow(a.accent) }}
                    aria-hidden="true"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm" style={{ color: lit(a.accent) }}>
                      {a.name}
                    </span>
                    {hot && <Unread n={a.unread} />}
                  </span>
                  <span className={`mt-0.5 block truncate text-xs ${hot ? 'text-neutral-300' : 'text-neutral-400'}`}>
                    {a.lastText ? (
                      <>
                        <span className="text-neutral-400">他：</span>
                        {a.lastText}
                      </>
                    ) : (
                      a.tagline
                    )}
                    {a.lastAt != null && <span className="ml-1 text-neutral-500">· {timeAgo(a.lastAt)}</span>}
                  </span>
                </span>
              </>
            );
            return (
              <li
                key={a.slug}
                className="rounded-xl"
                style={hot ? { background: tint(a.accent, 7) } : undefined}
              >
                {a.friend ? (
                  <button
                    className="group flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-white/[0.03]"
                    onClick={() => onOpen(a.slug)}
                  >
                    {row}
                    <span className="-my-1 inline-flex min-h-6 shrink-0 items-center self-center rounded px-1.5 text-xs text-neutral-400 transition group-hover:bg-white/5 group-hover:text-neutral-200">
                      进去说
                    </span>
                  </button>
                ) : (
                  <div className="flex items-start gap-2.5 rounded-xl px-2 py-2">
                    {row}
                    <button
                      className="-my-1 inline-flex min-h-6 shrink-0 items-center self-center rounded px-1.5 text-xs text-neutral-400 transition hover:bg-white/5 hover:text-neutral-200 disabled:opacity-40"
                      disabled={busy === a.slug}
                      onClick={() => onAdd(a.slug)}
                    >
                      {busy === a.slug ? '…' : '+ 加好友'}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
          {/* 名册出头时底边不硬切：这一条贴在滚动口下沿，滚在半路它把被切的那行压进渐隐里；
              滚到底它落回最后一行之后（落在留白处），不挡内容也不挡点击 */}
          <li
            aria-hidden="true"
            data-roster-fade
            className="pointer-events-none sticky bottom-0 block h-4 bg-gradient-to-t from-card to-transparent"
          />
        </ul>
      )}

      {/* 通高之后把这一行压到底：它是全局的一个设置，谁都不属于 */}
      <div className="mt-auto">
        <ProactiveSwitch state={proactive} err={proactiveErr} onToggle={onToggle} />
      </div>
    </div>
  );
}
