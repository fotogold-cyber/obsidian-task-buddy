import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

/**
 * Telegram webhook to capture chat_id automatically.
 * Set webhook URL: https://project--<id>.lovable.app/api/public/telegram/webhook
 * Use a secret_token derived from TELEGRAM_API_KEY when calling setWebhook.
 */
export const Route = createFileRoute("/api/public/telegram/webhook")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const TELEGRAM_API_KEY = process.env.TELEGRAM_API_KEY;
        if (!TELEGRAM_API_KEY) return new Response("Not configured", { status: 500 });

        // Validate via X-Telegram-Bot-Api-Secret-Token (sha256 of telegram api key)
        const expected = await sha256Base64Url(`telegram-webhook:${TELEGRAM_API_KEY}`);
        const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
        if (got !== expected) return new Response("Unauthorized", { status: 401 });

        const update = await request.json().catch(() => null);
        const message = update?.message ?? update?.edited_message;
        const chatId = message?.chat?.id;
        const text: string | undefined = message?.text;
        if (!chatId) return Response.json({ ok: true, ignored: true });

        // On /start, save chat_id
        if (text?.trim().startsWith("/start")) {
          const supabase = createClient(
            process.env.SUPABASE_URL!,
            process.env.SUPABASE_SERVICE_ROLE_KEY!,
            { auth: { autoRefreshToken: false, persistSession: false } },
          );
          await supabase
            .from("settings")
            .update({ telegram_chat_id: String(chatId) })
            .eq("id", 1);

          // Acknowledge to user
          await fetch("https://connector-gateway.lovable.dev/telegram/sendMessage", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${process.env.LOVABLE_API_KEY}`,
              "X-Connection-Api-Key": TELEGRAM_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              chat_id: chatId,
              text: "✅ Привязал чат. Теперь сюда будут приходить напоминания о задачах.",
            }),
          });
        }

        return Response.json({ ok: true });
      },
    },
  },
});

async function sha256Base64Url(input: string) {
  const bytes = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
