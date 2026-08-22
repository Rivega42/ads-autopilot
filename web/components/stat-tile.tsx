import type { ReactNode } from 'react';

export interface StatTileProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: ReactNode;
  /** Главное число экрана. Ровно одно на страницу. */
  readonly hero?: boolean;
}

export function StatTile({ label, value, hint, hero = false }: StatTileProps) {
  return (
    <div className={hero ? 'tile tile-hero' : 'tile'}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {hint ? <div className="tile-hint">{hint}</div> : null}
    </div>
  );
}
