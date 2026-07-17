const express = require('express');
const webpush = require('web-push');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:example@example.com';
const TICK_SECRET = process.env.TICK_SECRET || '';

for (const [name, val] of Object.entries({ SUPABASE_URL, SERVICE_KEY, VAPID_PUBLIC, VAPID_PRIVATE })) {
  if (!val) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${res.status} on ${path}: ${text}`);
  }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('application/json') ? res.json() : null;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code).trim().toUpperCase()).digest('hex');
}
function generateCode() {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(16);
  let code = '';
  for (let i = 0; i < 16; i++) {
    code += charset[bytes[i] % charset.length];
    if (i % 4 === 3 && i !== 15) code += '-';
  }
  return code;
}

app.post('/sync/create', async (req, res) => {
  try {
    const code = generateCode();
    await sb('sync_accounts', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ code_hash: hashCode(code), settings: {}, log: {} }),
    });
    res.json({ code });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'could not create sync account' });
  }
});

app.post('/sync/pull', async (req, res) => {
  try {
    const { code, todayKey } = req.body;
    if (!code) return res.status(400).json({ error: 'missing code' });
    const codeHash = hashCode(code);
    const rows = await sb(`sync_accounts?code_hash=eq.${codeHash}&select=settings,log`);
    if (!rows || !rows.length) return res.status(404).json({ error: 'code not found' });
    let pushState = null;
    if (todayKey) {
      const stateRows = await sb(`push_state?code_hash=eq.${codeHash}&date=eq.${todayKey}`);
      pushState = (stateRows && stateRows[0]) || null;
    }
    res.json({ settings: rows[0].settings, log: rows[0].log, pushState });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'sync failed' });
  }
});

app.post('/sync/push', async (req, res) => {
  try {
    const { code, settings, log } = req.body;
    if (!code) return res.status(400).json({ error: 'missing code' });
    const result = await sb(`sync_accounts?code_hash=eq.${hashCode(code)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ settings, log, updated_at: new Date().toISOString() }),
    });
    if (!result || !result.length) return res.status(404).json({ error: 'code not found' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'sync failed' });
  }
});

app.post('/sync/subscribe', async (req, res) => {
  try {
    const { code, subscription, timezone } = req.body;
    if (!code || !subscription || !subscription.endpoint) return res.status(400).json({ error: 'missing fields' });
    const codeHash = hashCode(code);
    const acct = await sb(`sync_accounts?code_hash=eq.${codeHash}&select=code_hash`);
    if (!acct || !acct.length) return res.status(404).json({ error: 'code not found' });
    await sb('push_subscriptions?on_conflict=endpoint', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        code_hash: codeHash,
        endpoint: subscription.endpoint,
        subscription,
        timezone: timezone || 'UTC',
      }),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'subscribe failed' });
  }
});

app.post('/sync/schedule-nudge', async (req, res) => {
  try {
    const { code, type, dueAt } = req.body;
    if (!code || !type || !dueAt) return res.status(400).json({ error: 'missing fields' });
    await sb('pending_nudges', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ code_hash: hashCode(code), type, due_at: new Date(dueAt).toISOString(), sent: false }),
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'schedule failed' });
  }
});

app.post('/sync/test-push', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'missing code' });
    const codeHash = hashCode(code);
    const subRows = await sb(`push_subscriptions?code_hash=eq.${codeHash}&select=endpoint`);
    if (!subRows || !subRows.length) return res.status(404).json({ error: 'no push subscription found for this code on this server' });
    const ok = await sendPushToAccount(codeHash, { title: 'ChaseClock test', body: 'If you see this, real push notifications are working.', tag: 'test-push' });
    res.json({ ok, subscriptionCount: subRows.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'test push failed' });
  }
});

function ymdInZone(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
function hmInZone(date, tz) {
  const s = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
}
function dowInZone(date, tz) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[s];
}
function minutesToHHMM(total) {
  total = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

async function sendPushToAccount(codeHash, payload) {
  const subs = await sb(`push_subscriptions?code_hash=eq.${codeHash}`);
  let sentAny = false;
  for (const row of subs || []) {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(payload));
      sentAny = true;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await sb(`push_subscriptions?endpoint=eq.${encodeURIComponent(row.endpoint)}`, {
          method: 'DELETE',
          headers: { Prefer: 'return=minimal' },
        }).catch(() => {});
      } else {
        console.error('push send failed', codeHash, err.statusCode);
      }
    }
  }
  return sentAny;
}

app.get('/tick', async (req, res) => {
  if (TICK_SECRET && req.query.secret !== TICK_SECRET) return res.status(401).json({ error: 'unauthorized' });

  const now = new Date();
  let checked = 0, sent = 0;
  try {
    const accounts = await sb('sync_accounts?select=code_hash,settings,log');

    for (const acc of accounts || []) {
      checked++;
      const codeHash = acc.code_hash;
      try {
        const st = acc.settings || {};
        if (st.enabled === false) continue;

        const subRows = await sb(`push_subscriptions?code_hash=eq.${codeHash}&select=timezone&limit=1`);
        if (!subRows || !subRows.length) continue;
        const tz = subRows[0].timezone || 'UTC';

        const today = ymdInZone(now, tz);
        const nowMin = hmInZone(now, tz);
        const dow = dowInZone(now, tz);
        const isActiveDay = !st.activeDays || st.activeDays.includes(dow);
        const todayLog = (acc.log && acc.log[today]) || {};

        const stateRows = await sb(`push_state?code_hash=eq.${codeHash}&date=eq.${today}`);
        const state = (stateRows && stateRows[0]) || { early_in: false, early_out: false, main_in_last_sent: null, main_out_last_sent: null };
        let stateChanged = false;

        const fireOnceIfDue = async (stateKey, timeStr, body, tag, logType) => {
          if (!isActiveDay || !timeStr || state[stateKey]) return;
          if (todayLog[logType] && todayLog[logType].time) return;
          const [h, m] = timeStr.split(':').map(Number);
          if (nowMin >= h * 60 + m) {
            const ok = await sendPushToAccount(codeHash, { title: 'ChaseClock', body, tag });
            if (ok) { state[stateKey] = true; stateChanged = true; sent++; }
          }
        };

        const fireRepeatingIfDue = async (lastSentKey, timeStr, body, tag, logType) => {
          if (!isActiveDay || !timeStr) return;
          if (todayLog[logType] && todayLog[logType].time) return;
          const [h, m] = timeStr.split(':').map(Number);
          const schedMin = h * 60 + m;
          if (nowMin < schedMin || nowMin > schedMin + 180) return;

          const lastSent = state[lastSentKey] ? new Date(state[lastSentKey]).getTime() : null;
          const repeatMs = Math.max(1, st.snoozeMinutes || 10) * 60000;
          if (lastSent && now.getTime() - lastSent < repeatMs) return;

          const ok = await sendPushToAccount(codeHash, { title: 'ChaseClock', body, tag });
          if (ok) { state[lastSentKey] = now.toISOString(); stateChanged = true; sent++; }
        };

        if (isActiveDay) {
          if (st.earlyInMinutes > 0 && st.clockInTime) {
            const [h, m] = st.clockInTime.split(':').map(Number);
            await fireOnceIfDue('early_in', minutesToHHMM(h * 60 + m - st.earlyInMinutes), "Clock-in's coming up — pop in when you get a sec.", 'earlyIn', 'clockIn');
          }
          await fireRepeatingIfDue('main_in_last_sent', st.clockInTime, 'Time to clock in.', 'mainIn', 'clockIn');
          if (st.earlyOutMinutes > 0 && st.clockOutTime) {
            const [h, m] = st.clockOutTime.split(':').map(Number);
            await fireOnceIfDue('early_out', minutesToHHMM(h * 60 + m - st.earlyOutMinutes), "Clock-out's coming up soon.", 'earlyOut', 'clockOut');
          }
          await fireRepeatingIfDue('main_out_last_sent', st.clockOutTime, 'Hey, forgot to clock out or something?', 'mainOut', 'clockOut');
        }

        if (stateChanged) {
          await sb('push_state?on_conflict=code_hash,date', {
            method: 'POST',
            headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
            body: JSON.stringify({
              code_hash: codeHash, date: today,
              early_in: state.early_in, early_out: state.early_out,
              main_in_last_sent: state.main_in_last_sent, main_out_last_sent: state.main_out_last_sent,
            }),
          }).catch((e) => console.error('state save failed', codeHash, e));
        }

        const pending = await sb(`pending_nudges?code_hash=eq.${codeHash}&sent=eq.false`);
        for (const p of pending || []) {
          if (new Date(p.due_at).getTime() <= now.getTime()) {
            const label = p.type === 'clockIn' ? 'Clock-in reminder — you snoozed this.' : 'Clock-out reminder — you snoozed this.';
            const ok = await sendPushToAccount(codeHash, { title: 'ChaseClock', body: label, tag: p.type + '-nudge' });
            if (ok) {
              await sb(`pending_nudges?id=eq.${p.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ sent: true }) }).catch(() => {});
              sent++;
            }
          }
        }
      } catch (accErr) {
        console.error('tick failed for one account, continuing with the rest', codeHash, accErr);
      }
    }
    res.json({ ok: true, checked, sent });
  } catch (e) {
    console.error('tick failed', e);
    res.status(500).json({ error: 'tick failed' });
  }
});

app.get('/', (req, res) => res.send('ChaseClock sync + push server is running.'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ChaseClock server listening on', PORT));
