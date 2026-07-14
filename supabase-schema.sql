# ChaseClock sync + push server — deployment steps

This is the small always-reachable piece that lets ChaseClock sync across your devices and send
real push notifications even when the app isn't open. Your phone and browser never talk to this
server directly for push delivery — they talk to it for sync, and it talks to Supabase and to the
push services (Apple/Google/Mozilla) on your behalf.

Budget ~20-30 minutes for first-time setup. Three free accounts needed: Supabase, Render, cron-job.org.

## 1. Create the database (Supabase)

1. Go to [supabase.com](https://supabase.com) → sign up (free) → **New project**.
2. Once it's ready, open **SQL Editor** → **New query**, paste the entire contents of
   `supabase-schema.sql` (included alongside this file), and click **Run**.
3. Go to **Project Settings → API**. You'll need two values in a moment:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **service_role key** (NOT the `anon` `public` key — the other one, marked secret)

## 2. Generate your VAPID keys

These let push services verify the notifications are really coming from your server. On your own
computer, with Node.js installed:

```
npx web-push generate-vapid-keys
```

This prints a Public Key and a Private Key. Save both — you'll paste the Public one into the
ChaseClock app itself, and both into Render's environment variables next.

## 3. Deploy the server (Render)

1. Put this `chaseclock-server` folder in its own GitHub repo (Render deploys from Git).
2. Go to [render.com](https://render.com) → sign up (free, no card needed) → **New → Web Service**
   → connect that repo.
3. Runtime: **Node**. Build command: `npm install`. Start command: `npm start`.
4. Under **Environment**, add every variable from `.env.example` with your real values.
5. Deploy. Once live, Render gives you a URL like `https://chaseclock-server.onrender.com` —
   save it, you'll paste it into the ChaseClock app too.
6. Visit `https://your-url.onrender.com/` in a browser — you should see
   "ChaseClock sync + push server is running."

## 4. Keep it alive and ticking (cron-job.org)

Render's free tier sleeps after 15 minutes with no traffic. This step both wakes it up and *is*
the actual "check if it's time to notify anyone" trigger — one free service does both jobs.

1. Go to [cron-job.org](https://cron-job.org) → sign up (free) → **Create cronjob**.
2. URL: `https://your-render-url.onrender.com/tick?secret=YOUR_TICK_SECRET`
   (the same `TICK_SECRET` you set in Render's environment variables).
3. Schedule: every 1 minute.
4. Save and enable it.

## 5. Connect the app

Open ChaseClock → Settings → Sync & real push section:
- Paste your Render URL into "Sync server URL."
- Paste your VAPID **public** key into "Push public key."
- Tap **Create new sync code**, save the code somewhere safe (there's no email tied to it — if
  it's lost, that data's gone), then enter that same code on your other device to link it.

## Honest notes

- I couldn't test this end-to-end myself (no live network access from where I build). The most
  likely first-attempt hiccups: a typo'd environment variable, or the service-role key swapped
  with the anon key. Both show up as clear error messages in Render's **Logs** tab — send me what
  you see there and I'll help debug.
- All four free tiers here (Supabase, Render, cron-job.org, and your data volume) are generous
  enough that a single personal user won't come close to any limit.
