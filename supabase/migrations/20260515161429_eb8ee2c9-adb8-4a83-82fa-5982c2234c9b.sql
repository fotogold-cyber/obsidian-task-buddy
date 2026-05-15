CREATE EXTENSION IF NOT EXISTS pg_cron;

SELECT cron.schedule(
  'cleanup-notification-log-30d',
  '0 3 * * *',
  $$ DELETE FROM public.notification_log WHERE sent_at < now() - interval '30 days'; $$
);