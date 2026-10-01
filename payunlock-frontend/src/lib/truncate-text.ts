export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit);
  const completeWords = /\s/.test(text.charAt(limit)) ? prefix : prefix.replace(/\s+\S*$/, "");
  return `${completeWords.trimEnd()}…`;
}
