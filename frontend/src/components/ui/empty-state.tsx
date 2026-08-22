import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  className?: string;
}

/**
 * Shared empty state for lists and grids — icon, message, optional action.
 * Replaces the ad-hoc "No X found" divs scattered across the app so every
 * empty view reads the same and always offers a way forward when there is one.
 */
export function EmptyState({ icon: Icon, title, description, action, className }: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}>
      {Icon && (
        <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gray-100">
          <Icon className="text-gray-400" size={22} aria-hidden="true" />
        </div>
      )}
      <p className="font-semibold text-gray-900">{title}</p>
      {description && <p className="mt-1 max-w-xs text-sm text-gray-500">{description}</p>}
      {action && (
        <Button className="mt-4 min-h-11" onClick={action.onClick}>{action.label}</Button>
      )}
    </div>
  );
}
