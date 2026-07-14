# Copy this file's contents into Render's Environment Variables settings — don't commit a real .env file.

# Supabase → Project Settings → API
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_KEY=your-service-role-key-NOT-the-anon-key

# Generate with: npx web-push generate-vapid-keys
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:youremail@example.com

# Make this up yourself (any random string) — it's the password your cron pinger uses
# to call /tick, so randoms on the internet can't trigger it.
TICK_SECRET=choose-a-random-string-here
