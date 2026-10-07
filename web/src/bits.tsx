import type { ReactNode } from 'react';

/**
 * 界面上的几个小共用件。帖子、单聊、吧友名录都要画同一个头像/打字点/同一种"他自己那一色"，
 * 分散在三个文件里迟早会长歪 —— 所以放一处。
 */

/**
 * 页首那条横幅：服务端说了什么就显示什么。
 * `retry` 是横幅上那个按钮要干的事（流断了叫「重连」，他主动来找你叫「去看看」）；
 * `tone` 只是配色 —— 出错是红的，"他给你留了句话"是普通的一条。
 */
export type Notice = { text: string; tone?: 'error' | 'info'; retry?: () => void; retryLabel?: string };

/**
 * accent 是给人当头像用的中低明度色，直接当文字色太暗（对比度不够）。
 * 用 color-mix 把它往白里提一点 —— 不新增颜色，还是他自己那一色。
 */
export const lit = (accent: string, pct = 72) => `color-mix(in oklab, ${accent} ${pct}%, white)`;

/** 同一色的淡淡一层，用来铺单聊气泡的底。 */
export const tint = (accent: string, pct = 12) => `color-mix(in oklab, ${accent} ${pct}%, transparent)`;

/**
 * 楼层在洞壁上那道凿痕：还是他自己那一色，但只留一点 —— 竖着的一小段，
 * 让每一楼都能被"认脸"，而不用往名字后面堆标签。
 */
export const mark = (accent: string, pct = 45) => `color-mix(in oklab, ${accent} ${pct}%, transparent)`;

/**
 * 从洞壁那一竖起笔、往字那边渐隐的一道 —— 他是从墙上往这栋楼里说的话。
 * 方向是"往里说"，不是箭头，也不连人。
 */
export const chisel = (accent: string, pct = 62) => `linear-gradient(90deg, ${mark(accent, pct)}, transparent)`;

/** 壁上透出的光点：名录里每个人都从墙上往外散一点自己的色。 */
export const glow = (accent: string) =>
  `0 0 0 1px color-mix(in oklab, ${accent} 38%, transparent), 0 0 22px -7px color-mix(in oklab, ${accent} 80%, transparent)`;

/**
 * 头像三个方向（task-25）：
 *   A 色块＋首字（默认）—— 跟 B 站/贴吧的默认头像一路；
 *   B 像素小物件 —— 7×7 手画格，"这人不是真人"写在脸上，不假装；
 *   C "没设头像"灰底斜纹 —— 故意留着"懒得设头像"的粗糙感。
 * 方向与图案**按人指定**（slugs 那边定死，跟名字无关）；名字随时可能被改，
 * 所以首字永远取当前显示名，不另存。
 */
const MOTIFS: Record<string, string[]> = {
  猫: ['#.....#', '##...##', '#######', '#.#.#.#', '#.###.#', '#######', '.#####.'],
  月: ['...###.', '..##...', '.##....', '.##....', '.##....', '..##...', '...###.'],
};

/**
 * slug → 方向。表里没有的就是 A —— 新加的吧友不写这张表也不会画错。
 * `tutu`（原定"碗"）没进来：28px 行内那个尺寸下，碗的两条边框只剩两个点、认不出是碗
 * （见 F:\tmp\avatar-probe.png 目验），按 Lead 的兜底条款回 A。**不能只在大位用它** ——
 * 同一个人在两处长得不一样，比略糊更假。
 */
const DIRECTION: Record<string, { kind: 'pixel'; motif: string } | { kind: 'blank' }> = {
  anhe: { kind: 'pixel', motif: '月' },
  daju: { kind: 'pixel', motif: '猫' },
  laolu: { kind: 'blank' },
  hukai: { kind: 'blank' },
  laoding: { kind: 'blank' },
  niangniang: { kind: 'blank' },
};

/**
 * 尺寸只按**用法档**，不按人 —— 同一档里所有人一样大（一排里某人比别人大一圈，比"像素略糊"更假）。
 * inline 行内（楼层/楼主行/单聊气泡/左栏列表行）· list 名录与右栏 · big 单聊头那种大位。
 */
const SIZE = {
  inline: 'h-7 w-7 shrink-0 text-xs',
  list: 'h-8 w-8 shrink-0 text-sm',
  big: 'h-11 w-11 shrink-0 text-base',
} as const;
export type AvatarSize = keyof typeof SIZE;

export function Avatar({
  name,
  accent,
  slug,
  size = 'inline',
  className = '',
}: {
  name: string;
  accent: string;
  slug?: string | null;
  size?: AvatarSize;
  className?: string;
}) {
  const round = `flex shrink-0 items-center justify-center rounded-full font-medium ${SIZE[size]} ${className}`;
  const dir = slug ? DIRECTION[slug] : undefined;
  const first = name.slice(0, 1);

  if (dir?.kind === 'pixel') {
    const grid = MOTIFS[dir.motif] ?? [];
    return (
      <div className={round} style={{ background: '#F4F4F4' }} aria-hidden="true">
        <svg viewBox="0 0 21 21" className="h-[88%] w-[88%]" aria-hidden="true">
          {grid.flatMap((row, r) =>
            [...row].map((c, x) =>
              c === '#' ? <rect key={`${r}-${x}`} x={x * 3} y={r * 3} width={3} height={3} fill="#2B2B2B" /> : null,
            ),
          )}
        </svg>
      </div>
    );
  }

  if (dir?.kind === 'blank') {
    return (
      <div
        className={round}
        style={{
          background: 'repeating-linear-gradient(45deg, #E9E9E9 0 4px, #DCDCDC 4px 8px)',
          boxShadow: 'inset 0 0 0 1px #CFCFCF',
          color: '#8A8A8A',
        }}
        aria-hidden="true"
      >
        {first}
      </div>
    );
  }

  return (
    <div className={`${round} text-white/95`} style={{ background: accent }} aria-hidden="true">
      {first}
    </div>
  );
}

/** 还没开口 / 正在打字。label 是给读屏用的，不是装饰。只有单聊在用。 */
export function Dots({ accent, label, className = '' }: { accent: string; label: string; className?: string }) {
  return (
    <span className={`flex gap-1 py-1 ${className}`} role="status" aria-label={label}>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="sd-dot h-1.5 w-1.5 rounded-full"
          style={{ background: accent, animationDelay: `${i * 0.18}s` }}
        />
      ))}
    </span>
  );
}

/** 段落小标题（洞里的帖子 / 洞里住着的人）：字小、字距开、不抢内容。 */
export function SectionLabel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`text-xs tracking-[0.14em] text-neutral-400 ${className}`}>{children}</div>;
}
