'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export interface NavProps {
  readonly pendingApprovals: number;
}

const LINKS: readonly { readonly href: string; readonly label: string }[] = [
  { href: '/clients', label: 'Клиенты' },
  { href: '/campaigns', label: 'Кампании' },
  { href: '/changes', label: 'История изменений' },
  { href: '/approvals', label: 'Апрувы' },
];

export function Nav({ pendingApprovals }: NavProps) {
  const pathname = usePathname();

  return (
    <nav className="nav">
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(`${link.href}/`);
        return (
          <Link
            key={link.href}
            className="nav-link"
            href={link.href}
            aria-current={active ? 'page' : undefined}
          >
            {link.label}
            {link.href === '/approvals' && pendingApprovals > 0 ? (
              <span className="nav-count">{pendingApprovals}</span>
            ) : null}
          </Link>
        );
      })}
    </nav>
  );
}
