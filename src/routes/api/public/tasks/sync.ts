import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const TaskSchema = z.object({
  obsidian_id: z.string().min(1).max(255),
  title: z.string().min(1).max(2000),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  notify_minutes_before: z.number().int().min(0).max(60 * 24 * 30).optional(),
  completed: z.boolean().optional(),
  vault_path: z.string().max(2000).nullable().optional(),
});

const BodySchema = z.object({
  mode: z.enum(["push", "full"]),
  tasks: z.array(TaskSchema).max(5000),
});

function getAdmin() {
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export const Route = createFileRoute("/api/public/tasks/sync")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const apiKey = request.headers.get("x-api-key");
        if (!apiKey || apiKey !== process.env.PLUGIN_API_KEY) {
          return new Response(JSON.stringify({ error: "Unauthorized" }), {
            status: 401,
            headers: { "Content-Type": "application/json" },
          });
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return Response.json({ error: "Invalid JSON" }, { status: 400 });
        }

        const parsed = BodySchema.safeParse(body);
        if (!parsed.success) {
          return Response.json(
            { error: "Validation failed", details: parsed.error.flatten() },
            { status: 400 },
          );
        }

        const { mode, tasks } = parsed.data;
        const supabase = getAdmin();

        // Fetch existing rows for incoming ids to detect changes that should reset notified_at
        const incomingIds = tasks.map((t) => t.obsidian_id);
        const { data: existing, error: existingErr } = await supabase
          .from("tasks")
          .select("obsidian_id, due_at, notify_minutes_before, notified_at")
          .in("obsidian_id", incomingIds.length ? incomingIds : ["__none__"]);

        if (existingErr) {
          return Response.json({ error: existingErr.message }, { status: 500 });
        }

        const existingMap = new Map(
          (existing ?? []).map((r) => [r.obsidian_id as string, r]),
        );

        const rows = tasks.map((t) => {
          const prev = existingMap.get(t.obsidian_id);
          const newDue = t.due_at ?? null;
          const newNotify = t.notify_minutes_before ?? 15;
          // Reset notified_at if scheduling changed
          let notified_at: string | null | undefined = undefined;
          if (
            prev &&
            (String(prev.due_at ?? "") !== String(newDue ?? "") ||
              prev.notify_minutes_before !== newNotify)
          ) {
            notified_at = null;
          }
          return {
            obsidian_id: t.obsidian_id,
            title: t.title,
            due_at: newDue,
            notify_minutes_before: newNotify,
            completed: t.completed ?? false,
            vault_path: t.vault_path ?? null,
            ...(notified_at === null ? { notified_at: null } : {}),
          };
        });

        if (rows.length > 0) {
          const { error: upErr } = await supabase
            .from("tasks")
            .upsert(rows, { onConflict: "obsidian_id" });
          if (upErr) return Response.json({ error: upErr.message }, { status: 500 });
        }

        let removed = 0;
        if (mode === "full") {
          // Anything not in payload -> delete (vault is source of truth)
          const { data: allRows, error: allErr } = await supabase
            .from("tasks")
            .select("obsidian_id");
          if (allErr) return Response.json({ error: allErr.message }, { status: 500 });
          const incoming = new Set(incomingIds);
          const toDelete = (allRows ?? [])
            .map((r) => r.obsidian_id as string)
            .filter((id) => !incoming.has(id));
          if (toDelete.length) {
            const { error: delErr } = await supabase
              .from("tasks")
              .delete()
              .in("obsidian_id", toDelete);
            if (delErr) return Response.json({ error: delErr.message }, { status: 500 });
            removed = toDelete.length;
          }
        }

        return Response.json({ ok: true, upserted: rows.length, removed, mode });
      },
    },
  },
});
