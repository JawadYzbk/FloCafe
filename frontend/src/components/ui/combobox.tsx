'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface ComboboxItem {
  value: string;
  label: string;
  /** Extra text matched against the query (e.g. a phone number). */
  keywords?: string;
  disabled?: boolean;
}

interface ComboboxProps {
  items: ComboboxItem[];
  value?: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  /** Trigger classes. */
  className?: string;
  contentClassName?: string;
  /** Optional node rendered under the list (e.g. a "create new" action). */
  footer?: React.ReactNode;
}

/**
 * Accessible combobox (the shadcn pattern) built on Radix Popover — a button
 * that opens a searchable, keyboard-navigable list. Dependency-free (no cmdk):
 * filtering is client-side over `label` + `keywords`. Arrow keys move the
 * active option, Enter selects, Esc closes.
 */
export function Combobox({
  items,
  value,
  onValueChange,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No results',
  disabled,
  className,
  contentClassName,
  footer,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => `${i.label} ${i.keywords ?? ''}`.toLowerCase().includes(q));
  }, [items, query]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const selected = items.find((i) => i.value === value);

  const commit = (item?: ComboboxItem) => {
    if (!item || item.disabled) return;
    onValueChange(item.value);
    setOpen(false);
    setQuery('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      commit(filtered[active]);
    }
  };

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); setActive(0); if (!o) setQuery(''); }}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={placeholder}
        className={cn(
          'border-input flex h-9 w-full items-center justify-between gap-2 rounded-md border bg-transparent px-3 py-2 text-sm whitespace-nowrap shadow-xs transition-[color,box-shadow] outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <span className={cn('line-clamp-1 text-start', !selected && 'text-muted-foreground')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronsUpDown className="size-4 shrink-0 opacity-50" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn('w-[var(--radix-popover-trigger-width)] min-w-56 p-0', contentClassName)}
        onOpenAutoFocus={(e) => { e.preventDefault(); (e.currentTarget as HTMLElement).querySelector<HTMLInputElement>('input')?.focus(); }}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 opacity-50" />
          <input
            value={query}
            onChange={(e) => { setQuery(e.target.value); setActive(0); }}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            className="h-9 w-full bg-transparent py-2 text-sm outline-none placeholder:text-muted-foreground"
            role="combobox"
            aria-expanded="true"
            aria-controls="combobox-list"
          />
        </div>
        <div ref={listRef} id="combobox-list" role="listbox" className="max-h-64 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.value}
                type="button"
                role="option"
                aria-selected={item.value === value}
                data-index={i}
                disabled={item.disabled}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(item)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-start text-sm outline-none disabled:pointer-events-none disabled:opacity-50',
                  i === active && 'bg-accent text-accent-foreground',
                )}
              >
                <Check className={cn('size-4 shrink-0', item.value === value ? 'opacity-100' : 'opacity-0')} />
                <span className="line-clamp-1">{item.label}</span>
              </button>
            ))
          )}
          {footer}
        </div>
      </PopoverContent>
    </Popover>
  );
}
