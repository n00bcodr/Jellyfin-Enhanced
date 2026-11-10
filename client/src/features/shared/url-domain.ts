/** Native external-link integration accepts navigable URLs, never executable schemes. */
export function safeExternalUrl(value: string, base: string): string {
 try {
  const url = new URL(value, base);
  return ['http:', 'https:', 'mailto:', 'tel:', 'ftp:', 'blob:'].includes(url.protocol) ? value : '#';
 } catch { return '#'; }
}
