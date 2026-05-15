import { createFileRoute } from "@tanstack/react-router";
import { runNotifyOnce } from "@/lib/notify.server";

export const Route = createFileRoute("/api/public/cron/notify")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apikey = request.headers.get("apikey");
        if (!apikey || apikey !== process.env.SUPABASE_PUBLISHABLE_KEY) {
          return new Response("Unauthorized", { status: 401 });
        }
        try {
          const result = await runNotifyOnce();
          return Response.json(result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          return Response.json({ error: msg }, { status: 500 });
        }
      },
    },
  },
});
