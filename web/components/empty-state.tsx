export interface EmptyStateProps {
  readonly children: string;
}

export function EmptyState({ children }: EmptyStateProps) {
  return <p className="empty">{children}</p>;
}
