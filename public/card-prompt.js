(function registerCardPrompt(global) {
  function deriveTitle(prompt, override = '') {
    const explicit = String(override || '').trim();
    if (explicit) return explicit.slice(0, 120);

    const firstLine = String(prompt || '').split(/\r?\n/).find((line) => line.trim()) || '';
    const title = firstLine
      .trim()
      .replace(/^#{1,6}\s+/, '')
      .replace(/^[-*+]\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!title) return 'New task';
    return title.length > 120 ? `${title.slice(0, 119).trimEnd()}…` : title;
  }

  function buildDescription(prompt, additionalContext = '') {
    const primary = String(prompt || '').trim();
    const additional = String(additionalContext || '').trim();
    return additional ? `${primary}\n\nAdditional context:\n${additional}` : primary;
  }

  global.todoCardPrompt = Object.freeze({ deriveTitle, buildDescription });
})(globalThis);
