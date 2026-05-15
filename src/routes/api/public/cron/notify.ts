import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const TELEGRAM_GATEWAY = "https://connector-gateway.lovable.dev/telegram";

function getAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function sendTelegram(chatId: string, text: string) {
  const LOVABLE_API_KEY = process.env.LOVABLE_API_KEY;
  const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
  if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY is not configured");
  if (!TELEGRAM_API_KEY) throw new Error("TELEGRAM_API_KEY is not configured");

  const res = await fetch(`${TELEGRAM_GATEWAY}/sendMessage`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LOVABLE_API_KEY}`,
      "X-Connection-Api-Key": TELEGRAM_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Telegram API failed [${res.status}]: ${JSON.stringify(data)}`);
  }
  return data;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDue(due: string) {
  const d = new Date(due);
  const now = new Date();
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60000);
  const time = d.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });
  if (diffMin <= 0) return `<b>${time}</b> (сейчас)`;
  if (diffMin < 60) return `<b>${time}</b> (через ${diffMin} мин)`;
  const h = Math.round(diffMin / 60);
  return `<b>${time}</b> (через ~${h} ч)`;
}

export const Route = createFileRoute("/api/public/cron/notify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Auth: anon key in apikey header (per Lovable cron pattern)
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("Unauthorized", { status: 401 });
        }

        const supabase = getAdmin();

        const { data: settings, error: setErr } = await supabase
          .from("settings")
          .select("telegram_chat_id")
          .eq("id", 1)
          .maybeSingle();
        if (setErr) return Response.json({ error: setErr.message }, { status: 500 });

        const chatId = settings?.telegram_chat_id;
        if (!chatId) {
          return Response.json({ ok: true, skipped: "no telegram_chat_id configured" });
        }

        // Find tasks whose notification window has arrived
        const nowIso = new Date().toISOString();
        const { data: due, error: dueErr } = await supabase
          .from("tasks")
          .select("id, title, due_at, notify_minutes_before, vault_path")
          .eq("completed", false)
          .is("notified_at", null)
          .not("due_at", "is", null)
          .lte("due_at", new Date(Date.now() + 1000 * 60 * 60 * 24 * 365).toISOString())
          .limit(100);
        if (dueErr) return Response.json({ error: dueErr.message }, { status: 500 });

        const ready = (due ?? []).filter((t) => {
          if (!t.due_at) return false;
          const triggerAt =
            new Date(t.due_at).getTime() - (t.notify_minutes_before ?? 15) * 60_000;
          return triggerAt <= Date.now();
        });

        let sent = 0;
        const results: Array<{ id: string; status: string; error?: string }> = [];

        for (const t of ready) {
          const text =
            `⏰ <b>${escapeHtml(t.title)}</b>\n` +
            `Дедлайн: ${formatDue(t.due_at!)}` +
            (t.vault_path ? `\n📄 <i>${escapeHtml(t.vault_path)}</i>` : "");
          try {
            await sendTelegram(chatId, text);
            await supabase.from("tasks").update({ notified_at: nowIso }).eq("id", t.id);
            await supabase.from("notification_log").insert({
              task_id: t.id,
              task_title: t.title,
              status: "sent",
            });
            sent++;
            results.push({ id: t.id, status: "sent" });
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            await supabase.from("notification_log").insert({
              task_id: t.id,
              task_title: t.title,
              status: "error",
              error: msg,
            });
            results.push({ id: t.id, status: "error", error: msg });
          }
        }

        return Response.json({
          ok: true,
          checked: due?.length ?? 0,
          ready: ready.length,
          sent,
          results,
        });
      },
    },
  },
});
