const PERU_TZ = 'America/Lima';

/** Format ISO timestamps for display in Peru local time. */
export function formatPeruDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return 'N/A';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return 'N/A';
  return d.toLocaleString('es-PE', {
    timeZone: PERU_TZ,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}
