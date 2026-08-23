'use client';

import { useTranslations, type AppConfig } from 'use-intl';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { CountryLocaleOptions, CurrencyDisplay, DigitMode, CalendarMode } from '@/lib/countries';

interface Props {
  options?: CountryLocaleOptions;
  currencyDisplay: CurrencyDisplay;
  digits: DigitMode;
  calendar: CalendarMode;
  isAdmin: boolean;
  onChange: (patch: { currencyDisplay?: CurrencyDisplay; digits?: DigitMode; calendar?: CalendarMode }) => void;
}

type SettingsKey = keyof AppConfig['Messages']['settings'];

// Option labels keyed by value. The panel itself is region-agnostic: which
// controls (and which options within them) are rendered is driven entirely by
// the country profile's `localeOptions`, so a region without locale options
// never sees this panel.
const CURRENCY_DISPLAY_LABELS = {
  rial: 'iranCurrencyDisplayRial',
  toman: 'iranCurrencyDisplayToman',
  toman_short: 'iranCurrencyDisplayTomanShort',
} as const satisfies Record<CurrencyDisplay, SettingsKey>;

const DIGIT_LABELS = {
  locale: 'iranNumberDigitsLocale',
  latin: 'iranNumberDigitsLatin',
} as const satisfies Record<DigitMode, SettingsKey>;

const CALENDAR_LABELS = {
  locale: 'iranCalendarLocale',
  persian: 'iranCalendarPersian',
  gregorian: 'iranCalendarGregorian',
} as const satisfies Record<CalendarMode, SettingsKey>;

export function LocalePreferencesPanel({ options, currencyDisplay, digits, calendar, isAdmin, onChange }: Props) {
  const t = useTranslations('settings');

  const hasAny = Boolean(
    options?.currencyDisplay?.length || options?.digits?.length || options?.calendar?.length,
  );
  if (!hasAny) return null;

  return (
    <div className="md:col-span-2 space-y-4 rounded-lg border border-gray-100 bg-gray-50/60 p-4">
      <p className="text-sm font-medium text-gray-700">{t('iranLocaleTitle')}</p>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {options?.currencyDisplay?.length ? (
          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('iranCurrencyDisplay')}</label>
            {isAdmin ? (
              <Select value={currencyDisplay} onValueChange={(v) => onChange({ currencyDisplay: v as CurrencyDisplay })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {options!.currencyDisplay!.map((mode) => (
                    <SelectItem key={mode} value={mode}>{t(CURRENCY_DISPLAY_LABELS[mode])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="font-medium text-gray-900">{t(CURRENCY_DISPLAY_LABELS[currencyDisplay])}</p>
            )}
          </div>
        ) : null}

        {options?.digits?.length ? (
          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('iranNumberDigits')}</label>
            {isAdmin ? (
              <Select value={digits} onValueChange={(v) => onChange({ digits: v as DigitMode })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {options!.digits!.map((mode) => (
                    <SelectItem key={mode} value={mode}>{t(DIGIT_LABELS[mode])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="font-medium text-gray-900">{t(DIGIT_LABELS[digits])}</p>
            )}
          </div>
        ) : null}

        {options?.calendar?.length ? (
          <div>
            <label className="block text-sm text-gray-500 mb-1">{t('iranCalendar')}</label>
            {isAdmin ? (
              <Select value={calendar} onValueChange={(v) => onChange({ calendar: v as CalendarMode })}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {options!.calendar!.map((mode) => (
                    <SelectItem key={mode} value={mode}>{t(CALENDAR_LABELS[mode])}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="font-medium text-gray-900">{t(CALENDAR_LABELS[calendar])}</p>
            )}
          </div>
        ) : null}
      </div>
      <p className="text-xs text-gray-400">{t('iranLocaleHint')}</p>
    </div>
  );
}
