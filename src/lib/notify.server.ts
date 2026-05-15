import { createClient } from "@supabase/supabase-js";

const TELEGRAM_GATEWAY = "https://connector-gateway.lovable.dev/telegram";

export function getAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function sendTelegram(chatId: string, text: string, replyMarkup?: unknown) {
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
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Telegram API failed [${res.status}]: ${JSON.stringify(data)}`);
  return data;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatDue(due: string) {
  const d = new Date(due);
  const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
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

function buildObsidianLink(vaultName: string | null, vaultPath: string | null, obsidianId?: string) {
  if (!vaultName || !vaultPath) return null;
  const lineMatch = obsidianId?.match(/#L(\d+)$/);
  const line = lineMatch ? Number(lineMatch[1]) + 1 : null;
  const direct =
    `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(vaultPath)}` +
    (line ? `&line=${line}` : "");
  return `https://obsidian-task-buddy.lovable.app/api/public/obsidian/open?target=${encodeURIComponent(direct)}`;
}

export async function runNotifyOnce() {
  const supabase = getAdmin();

  const { data: settings, error: setErr } = await supabase
    .from("settings")
    .select("telegram_chat_id")
    .eq("id", 1)
    .maybeSingle();
  if (setErr) throw new Error(setErr.message);

  const chatId = settings?.telegram_chat_id;
  if (!chatId) return { ok: true, skipped: "no telegram_chat_id configured" };

  const nowIso = new Date().toISOString();
  const { data: due, error: dueErr } = await supabase
    .from("tasks")
    .select("id, obsidian_id, title, due_at, notify_minutes_before, vault_path, vault_name")
    .eq("completed", false)
    .is("notified_at", null)
    .not("due_at", "is", null)
    .limit(200);
  if (dueErr) throw new Error(dueErr.message);

  const ready = (due ?? []).filter((t) => {
    if (!t.due_at) return false;
    const triggerAt = new Date(t.due_at).getTime() - (t.notify_minutes_before ?? 15) * 60_000;
    return triggerAt <= Date.now();
  });

  let sent = 0;
  const results: Array<{ id: string; status: string; error?: string }> = [];
  for (const t of ready) {
    const link = buildObsidianLink(t.vault_name, t.vault_path, t.obsidian_id);
    const text =
      `⏰ <b>${escapeHtml(t.title)}</b>\n` +
      `Дедлайн: ${formatDue(t.due_at!)}` +
      (t.vault_path ? `\n📄 <i>${escapeHtml(t.vault_path)}</i>` : "");
    const replyMarkup = link
      ? { inline_keyboard: [[{ text: "Открыть в Obsidian", url: link }]] }
      : undefined;
    try {
      await sendTelegram(chatId, text, replyMarkup);
      await supabase.from("tasks").update({ notified_at: nowIso }).eq("id", t.id);
      await supabase
        .from("notification_log")
        .insert({ task_id: t.id, task_title: t.title, status: "sent" });
      sent++;
      results.push({ id: t.id, status: "sent" });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await supabase
        .from("notification_log")
        .insert({ task_id: t.id, task_title: t.title, status: "error", error: msg });
      results.push({ id: t.id, status: "error", error: msg });
    }
  }

  return { ok: true, checked: due?.length ?? 0, ready: ready.length, sent, results };
}
