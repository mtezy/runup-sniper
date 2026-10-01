import 'dotenv/config';
import { readFileSync } from 'node:fs';
const m = readFileSync('/root/.hermes/.env','utf8').match(/^\s*TELEGRAM_BOT_TOKEN\s*=\s*(\S+)/m);
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN || (m&&m[1]) || '').trim().replace(/^["']|["']$/g,'');
const CHAT = process.env.TELEGRAM_CHAT_ID || '782664019';
const IMG = 'https://runup.fun/tokens/runner.png';
async function post(method, body){
  const r = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j = await r.json();
  console.log(method, '=>', j.ok ? 'OK msg '+j.result.message_id : JSON.stringify(j));
}
await post('sendPhoto', { chat_id: CHAT, photo: IMG, caption: 'sendPhoto test (proves Telegram can fetch)' });
await post('sendPhoto', { chat_id: CHAT, photo: IMG+'?p='+Date.now(), caption: 'sendPhoto cachebust' });
