// EntityBuilder for Telegram Bot API messages (entities mode, NOT parse_mode).
// All offsets are UTF-16 code units == JS String.length, so plain JS concatenation is correct.
// Supports nested entities inside a blockquote via spanning bq()/bqEnd().
export class EntityBuilder {
  constructor() { this.text = ''; this.entities = []; }
  _push(type, s, extra) { const o = this.text.length; this.text += s; this.entities.push({ type, offset: o, length: s.length, ...extra }); return this; }
  add(s) { this.text += s; return this; }
  bold(s) { return this._push('bold', s); }
  italic(s) { return this._push('italic', s); }
  underline(s) { return this._push('underline', s); }
  strikethrough(s) { return this._push('strikethrough', s); }
  spoiler(s) { return this._push('spoiler', s); }
  code(s) { return this._push('code', s); }
  pre(s, language) { return this._push('pre', s, language ? { language } : undefined); }
  link(text, url) { return this._push('text_link', text, { url }); }
  dateTime(s, unix, fmt = 'r') { return this._push('date_time', s, { unix_time: unix, date_time_format: fmt }); }
  nl() { this.text += '\n'; return this; }
  // spanning blockquote: returns the start offset; pass it to bqEnd() AFTER adding inner content
  bq() { if (this.text && !this.text.endsWith('\n')) this.text += '\n'; return this.text.length; }
  bqEnd(start) { this.entities.push({ type: 'blockquote', offset: start, length: this.text.length - start }); return this; }
  build() {
    // container types first (blockquote), then the rest — stable, Telegram-agnostic ordering
    const order = { blockquote: 0, expandable_blockquote: 0 };
    const ents = [...this.entities].sort((a, b) => (order[a.type] ?? 1) - (order[b.type] ?? 1) || a.offset - b.offset || b.length - a.length);
    return { text: this.text, entities: ents };
  }
  static truncate(s, max) { return s.length <= max ? s : s.slice(0, max - 1) + '…'; }
}
