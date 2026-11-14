import type { AnnotationCardItem, CardEdge } from '../types';

export interface CardFoldState {
  /** 因为某个祖先被收起而隐藏的卡片 id。 */
  hidden: Set<string>;
  /** 每张已收起的卡片会连带隐藏多少张后代卡片。 */
  hiddenCounts: Map<string, number>;
}

/**
 * 思维导图式折叠：收起的卡片隐藏其下整棵子树。
 * 边允许成环，遍历用 visited 集合兜底。
 */
export function computeCardFoldState(
  cards: AnnotationCardItem[],
  edges: CardEdge[]
): CardFoldState {
  const childrenByParent = new Map<string, string[]>();
  for (const edge of edges) {
    const list = childrenByParent.get(edge.source);
    if (list) list.push(edge.target);
    else childrenByParent.set(edge.source, [edge.target]);
  }

  const hidden = new Set<string>();
  const hiddenCounts = new Map<string, number>();

  for (const card of cards) {
    if (!card.collapsed) continue;
    const subtree = new Set<string>([card.id]);
    const stack = [...(childrenByParent.get(card.id) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (subtree.has(id)) continue;
      subtree.add(id);
      hidden.add(id);
      stack.push(...(childrenByParent.get(id) ?? []));
    }
    hiddenCounts.set(card.id, subtree.size - 1);
  }

  return { hidden, hiddenCounts };
}
