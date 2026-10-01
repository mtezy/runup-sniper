#!/usr/bin/env node
/**
 * RUNUP — Telegram notifier.
 * Sends messages via the @digidawbbot bot (token from TELEGRAM_BOT_TOKEN or ~/.hermes/.env).
 * Default target = langris DM (TELEGRAM_CHAT_ID or 782664019).
 */
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function loadToken() {
  if (process.env.TELEGRAM_BOT_TOKEN) return process.env.TELEGRAM_BOT_TOKEN;
  // fall back to the Hermes credential store
  for (const p of [join(homedir(), '.hermes', '.env'), '/root/.hermes/.env']) {
    if (!existsSync(p)) continue;
    const m = readFileSync(p, 'utf8').match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

const TOKEN = loadToken();
export const CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || process.env.RUNUP_CHAT_ID || '782664019');
export const hasToken = !!TOKEN;

/**
 * Send an HTML message. Returns the Telegram message_id, or null on failure.
 * Never logs the token.
 */
export async function sendTelegram(text, { chatId = CHAT_ID, disablePreview = true, silent = false } = {}) {
  if (!TOKEN) { console.error('[notify] no TELEGRAM_BOT_TOKEN — message not sent'); return null; }
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: disablePreview,
    disable_notification: silent,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) return j.result.message_id;
      if (j.error_code === 429) { await new Promise(s => setTimeout(s, (j.parameters?.retry_after || 2) * 1000)); continue; }
      console.error('[notify] send failed:', j.description);
      return null;
    } catch (e) {
      if (attempt === 2) { console.error('[notify] send error:', e.message); return null; }
      await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return null;
}

// escape for HTML parse_mode
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const short = (a) => (a && a.length > 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

/**
 * Send a message built with EntityBuilder (entities mode — NOT parse_mode).
 * @param {{text:string, entities:Array}} built
 * @param {{chatId?:string, replyMarkup?:object, imageUrl?:string, silent?:boolean, previewUrl?:string}} opts
 * Returns the Telegram message_id, or null on failure. Never logs the token.
 */
export async function sendAlert(built, { chatId = CHAT_ID, replyMarkup = null, imageUrl = null, previewUrl = null, silent = false } = {}) {
  if (!TOKEN) { console.error('[notify] no TELEGRAM_BOT_TOKEN — message not sent'); return null; }
  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  const body = { chat_id: chatId, text: built.text, entities: built.entities };
  if (silent) body.disable_notification = true;
  if (replyMarkup) body.reply_markup = replyMarkup;
  // link preview: a raw image URL renders a card (image above the text). Telegram caches a FAILED
  // preview for a given URL, so append a cache-buster each send to force a fresh fetch.
  if (imageUrl || previewUrl) {
    let u = imageUrl || previewUrl;
    try { const x = new URL(u); x.searchParams.set('t', String(Date.now())); u = x.toString(); } catch {}
    body.link_preview_options = { is_disabled: false, url: u, prefer_large_media: true, show_above_text: true };
  } else body.link_preview_options = { is_disabled: true };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (j.ok) return j.result.message_id;
      if (j.error_code === 429) { await new Promise(s => setTimeout(s, (j.parameters?.retry_after || 2) * 1000)); continue; }
      console.error('[notify] sendAlert failed:', j.description);
      return null;
    } catch (e) {
      if (attempt === 2) { console.error('[notify] sendAlert error:', e.message); return null; }
      await new Promise(s => setTimeout(s, 1000 * (attempt + 1)));
    }
  }
  return null;
}
