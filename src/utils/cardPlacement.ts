export interface PlacementBox {
  top: number;
  bottom: number;
}

export type PlacementPreference = 'nearest' | 'up';

const DEFAULT_GAP = 16;
const DEFAULT_MIN_Y = 16;

/**
 * 为高度 `height` 的卡片找一个不与已有卡片重叠的位置。
 *
 * 旧实现遇到冲突一律把卡片推到已有卡片下方，于是一列卡片只会越堆越靠下，
 * 上方留出空白也永远用不上。这里把「贴着上方放」也算作候选：
 * - `nearest`：取位移最小的位置（新建卡片用，上下都行）；
 * - `up`：优先往上叠（自动排列用，让卡片从锚点往上长）；
 *   上方实在放不下时再退回下方。
 */
export function nearestFreeY(
  idealY: number,
  height: number,
  boxes: PlacementBox[],
  gap = DEFAULT_GAP,
  minY = DEFAULT_MIN_Y,
  prefer: PlacementPreference = 'nearest'
): number {
  const ideal = Math.max(minY, idealY);
  const collides = (y: number) =>
    boxes.some((box) => y + height + gap > box.top && y < box.bottom + gap);

  if (!collides(ideal)) return Math.round(ideal);

  const candidates: number[] = [minY];
  for (const box of boxes) {
    candidates.push(box.bottom + gap); // 放到这张卡片下面
    candidates.push(box.top - height - gap); // 放到这张卡片上面
  }

  const free = candidates
    .map((candidate) => Math.max(minY, candidate))
    .filter((candidate) => !collides(candidate));

  if (free.length === 0) {
    // 兜底：整列都排满了，就接在最下方。
    return Math.round(
      Math.max(minY, ...boxes.map((box) => box.bottom + gap))
    );
  }

  if (prefer === 'up') {
    const above = free.filter((candidate) => candidate <= ideal);
    return Math.round(
      above.length > 0 ? Math.max(...above) : Math.min(...free)
    );
  }

  let best = free[0];
  for (const candidate of free) {
    if (
      Math.abs(candidate - ideal) + 1e-6 < Math.abs(best - ideal)
    ) {
      best = candidate;
    }
  }
  return Math.round(best);
}
