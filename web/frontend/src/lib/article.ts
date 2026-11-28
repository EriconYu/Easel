/** Extract a title only from a recognizable, standalone opening line. */
export function splitArticleHeading(text: string): { title: string; body: string } {
  const match = /^\s*([^\r\n]+)\r?\n([\s\S]+)$/u.exec(text);
  if (!match || !match[2].trim()) return {title: '', body: text};
  const firstLine = match[1].trim();
  const heading = /^(?:#\s+|(?:文章)?标题[：:]\s*)(.+)$/u.exec(firstLine)?.[1]
    ?? (match[2].startsWith('\n') || match[2].startsWith('\r\n') ? /^\*\*([^*]+)\*\*$/u.exec(firstLine)?.[1] : undefined);
  const title = heading?.trim().replace(/^\*\*(.+)\*\*$/u, '$1').trim() || '';
  return title && title.length <= 120 ? {title, body: match[2].trimStart()} : {title: '', body: text};
}

export function withoutRepeatedArticleHeading(text: string, articleTitle: string) {
  const heading = splitArticleHeading(text);
  return heading.title && heading.title === articleTitle ? heading.body : text;
}

export function splitDraftReply(text: string, streaming = false) {
  const start = text.indexOf('【正文开始】');
  if (start < 0) return null;
  const afterStart = start + '【正文开始】'.length;
  const end = text.indexOf('【正文结束】', afterStart);
  if (end < 0 && !streaming) return null;
  const body = text.slice(afterStart, end < 0 ? undefined : end).trim();
  if (!body && end >= 0) return null;
  const notes = [text.slice(0, start).trim(), end >= 0 ? text.slice(end + '【正文结束】'.length).trim() : '']
    .filter(Boolean).join('\n\n');
  return {body, notes};
}
