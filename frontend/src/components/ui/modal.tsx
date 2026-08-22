'use client';

import { Dialog as DialogPrimitive } from 'radix-ui';
import { X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { cn } from '@/lib/utils';

const SIZES = {
  sm: 'sm:max-w-sm',
  md: 'sm:max-w-md',
  lg: 'sm:max-w-lg',
  xl: 'sm:max-w-2xl',
} as const;

interface ModalProps {
  title: React.ReactNode;
  /** Optional sub-line under the title. */
  subtitle?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  size?: keyof typeof SIZES;
  /** Extra classes on the modal card. */
  className?: string;
  /** Hide the default header (caller renders its own inside children). */
  hideHeader?: boolean;
}

/**
 * Accessible modal shell over Radix Dialog: focus trap, Esc-to-close,
 * aria-modal + labelled title, background scroll-lock, and focus restoration
 * — replacing the hand-rolled `fixed inset-0` overlays across the POS. Renders
 * as a bottom sheet on mobile and a centered card on larger screens. Mount it
 * only while open (the parent controls visibility); it treats itself as open.
 */
export function Modal({ title, subtitle, onClose, children, size = 'md', className, hideHeader }: ModalProps) {
  const tCommon = useTranslations('common');
  return (
    <DialogPrimitive.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed inset-0 z-50 flex items-end justify-center p-0 outline-none sm:items-center sm:p-4"
        >
          <div className={cn('flex max-h-[92vh] w-full flex-col overflow-hidden rounded-t-3xl bg-white shadow-2xl sm:rounded-2xl', SIZES[size], className)}>
            {!hideHeader && (
              <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-5 pt-5 pb-4">
                <div className="min-w-0">
                  <DialogPrimitive.Title asChild>
                    <h2 className="truncate text-lg font-bold text-gray-900">{title}</h2>
                  </DialogPrimitive.Title>
                  {subtitle && <p className="mt-0.5 truncate text-xs text-gray-400">{subtitle}</p>}
                </div>
                <DialogPrimitive.Close asChild>
                  <button
                    type="button"
                    aria-label={tCommon('close')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-500 transition-colors hover:bg-gray-200"
                  >
                    <X size={16} />
                  </button>
                </DialogPrimitive.Close>
              </div>
            )}
            {hideHeader && (
              /* Still expose an accessible name for screen readers. */
              <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
            )}
            {children}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
