import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading placeholder for the POS product grid — mirrors the card layout so
 * the grid doesn't pop and shift when products arrive. Render while the menu
 * is loading in place of the grid.
 */
export default function ProductGridSkeleton({ count = 12, columns = 4 }: { count?: number; columns?: 4 | 5 }) {
  return (
    <div
      className={`grid gap-3 ${columns === 5 ? 'grid-cols-5' : 'grid-cols-4'}`}
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="rounded-xl border border-gray-100 bg-white p-2.5">
          <Skeleton className="mb-3 aspect-square w-full rounded-lg" />
          <Skeleton className="h-4 w-4/5 rounded" />
          <div className="mt-2 flex items-center justify-between">
            <Skeleton className="h-4 w-12 rounded" />
            <Skeleton className="h-8 w-8 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}
