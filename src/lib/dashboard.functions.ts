import { createServerFn } from "@tanstack/react-start";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

function getAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function checkKey(apiKey: string) {
  if (!process.env.PLUGIN_API_KEY) throw new Error("PLUGIN_API_KEY not configured");
  if (apiKey !== process.env.PLUGIN_API_KEY) throw new Error("Invalid API key");
}

const KeyInput = z.object({ apiKey: z.string().min(1) });

export const dashboardData = createServerFn({ method: "POST" })
  .inputValidator((input) => KeyInput.parse(input))
  .handler(async ({ data }) => {
    checkKey(data.apiKey);
    const supabase = getAdmin();

    const [tasksRes, settingsRes, logRes] = await Promise.all([
      supabase
        .from("tasks")
        .select("id, obsidian_id, title, due_at, notify_minutes_before, notified_at, completed, vault_path, updated_at")
        .order("due_at", { ascending: true, nullsFirst: false })
        .limit(500),
      supabase.from("settings").select("telegram_chat_id, default_lead_minutes").eq("id", 1).maybeSingle(),
      supabase
        .from("notification_log")
        .select("id, task_title, status, error, sent_at")
        .order("sent_at", { ascending: false })
        .limit(50),
    ]);

    if (tasksRes.error) throw new Error(tasksRes.error.message);
    if (settingsRes.error) throw new Error(settingsRes.error.message);
    if (logRes.error) throw new Error(logRes.error.message);

    return {
      tasks: tasksRes.data ?? [],
      settings: settingsRes.data ?? { telegram_chat_id: null, default_lead_minutes: 15 },
      log: logRes.data ?? [],
    };
  });

export const updateSettings = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    KeyInput.extend({
      telegram_chat_id: z.string().max(64).nullable(),
      default_lead_minutes: z.number().int().min(0).max(60 * 24 * 30),
    }).parse(input),
  )
  .handler(async ({ data }) => {
    checkKey(data.apiKey);
    const supabase = getAdmin();
    const { error } = await supabase
      .from("settings")
      .update({
        telegram_chat_id: data.telegram_chat_id || null,
        default_lead_minutes: data.default_lead_minutes,
      })
      .eq("id", 1);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteTask = createServerFn({ method: "POST" })
  .inputValidator((input) => KeyInput.extend({ id: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    checkKey(data.apiKey);
    const supabase = getAdmin();
    const { error } = await supabase.from("tasks").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const toggleCompleted = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    KeyInput.extend({ id: z.string().uuid(), completed: z.boolean() }).parse(input),
  )
  .handler(async ({ data }) => {
    checkKey(data.apiKey);
    const supabase = getAdmin();
    const { error } = await supabase
      .from("tasks")
      .update({ completed: data.completed })
      .eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const triggerNotifyNow = createServerFn({ method: "POST" })
  .inputValidator((input) => KeyInput.parse(input))
  .handler(async ({ data }) => {
    checkKey(data.apiKey);
    const { runNotifyOnce } = await import("@/lib/notify.server");
    return runNotifyOnce();
  });
