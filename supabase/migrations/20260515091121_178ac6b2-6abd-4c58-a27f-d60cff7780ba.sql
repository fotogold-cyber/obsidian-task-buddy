-- Tasks synced from Obsidian plugin
CREATE TABLE public.tasks (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  obsidian_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  notify_minutes_before INT NOT NULL DEFAULT 15,
  notified_at TIMESTAMPTZ,
  completed BOOLEAN NOT NULL DEFAULT false,
  vault_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_due_pending
  ON public.tasks (due_at)
  WHERE completed = false AND notified_at IS NULL AND due_at IS NOT NULL;

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- Settings: single-row config
CREATE TABLE public.settings (
  id INT PRIMARY KEY DEFAULT 1,
  telegram_chat_id TEXT,
  default_lead_minutes INT NOT NULL DEFAULT 15,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT settings_singleton CHECK (id = 1)
);

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

INSERT INTO public.settings (id, telegram_chat_id, default_lead_minutes)
VALUES (1, NULL, 15);

-- updated_at trigger function
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON public.tasks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_settings_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Notification log for visibility
CREATE TABLE public.notification_log (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  task_id UUID REFERENCES public.tasks(id) ON DELETE SET NULL,
  task_title TEXT,
  status TEXT NOT NULL,
  error TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.notification_log ENABLE ROW LEVEL SECURITY;