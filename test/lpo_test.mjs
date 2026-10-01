import 'dotenv/config';
import { readFileSync } from 'node:fs';
const m = readFileSync('/root/.hermes/.env','utf8').match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/m);
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || (m&&m[1]) || '').trim().replace(/^["']|["']$/g,'');
const CHAT = process.env.TELEGRAM_CHAT_ID || '782664019';
console.log('token?', !!TOKEN);
async function send(label, lpo){
  const body = { chat_id: CHAT, text: `🧪 ${label}`, link_preview_options: lpo };
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j = await r.json();
  console.log(label, '=>', j.ok ? 'OK msg '+j.result.message_id : JSON.stringify(j));
}
const IMG = 'https://runup.fun/tokens/runner.png';
await send('A base large above', { is_disabled:false, url:IMG, prefer_large_media:true, show_above_text:true });
await send('B cachebust large above', { is_disabled:false, url:IMG+'?v='+Date.now(), prefer_large_media:true, show_above_text:true });
await send('C small above', { is_disabled:false, url:IMG+'?s='+Date.now(), prefer_small_media:true, show_above_text:true });
await send('D large below', { is_disabled:false, url:IMG+'?b='+Date.now(), prefer_large_media:true, show_above_text:false });
