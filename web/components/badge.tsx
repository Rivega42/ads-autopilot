import type { ReactNode } from 'react';

import type { Tone } from '../lib/labels';

export interface BadgeProps {
  readonly tone?: Tone;
  readonly children: ReactNode;
}

/** Точка + подпись: статус никогда не передаётся одним лишь цветом. */
export function Badge({ tone = 'neutral', children }: BadgeProps) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function PlainBadge({ children }: { readonly children: ReactNode }) {
  return <span className="badge badge-plain">{children}</span>;
}
