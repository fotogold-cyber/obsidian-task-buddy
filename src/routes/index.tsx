import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  dashboardData,
  updateSettings,
  deleteTask,
  toggleCompleted,
  triggerNotifyNow,
} from "@/lib/dashboard.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";

export const Route = createFileRoute("/")({
  component: Dashboard,
  head: () => ({
    meta: [
      { title: "Obsidian Tasks · Dashboard" },
      { name: "description", content: "Personal task sync between Obsidian and Telegram" },
    ],
  }),
});

const KEY_STORAGE = "obsidian_tasks_api_key";

type Task = {
  id: string;
  obsidian_id: string;
  title: string;
  due_at: string | null;
  notify_minutes_before: number;
  notified_at: string | null;
  completed: boolean;
  vault_path: string | null;
  updated_at: string;
};

type Data = Awaited<ReturnType<typeof dashboardData>>;

function Dashboard() {
  const [apiKey, setApiKey] = useState<string>("");
  const [keyInput, setKeyInput] = useState("");
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(false);
  const [chatId, setChatId] = useState("");
  const [lead, setLead] = useState(15);

  const fetchData = useServerFn(dashboardData);
  const saveSettings = useServerFn(updateSettings);
  const removeTask = useServerFn(deleteTask);
  const toggleTask = useServerFn(toggleCompleted);
  const triggerNotify = useServerFn(triggerNotifyNow);

  useEffect(() => {
    const k = localStorage.getItem(KEY_STORAGE);
    if (k) setApiKey(k);
  }, []);

  const load = async (key: string) => {
    setLoading(true);
    try {
      const d = await fetchData({ data: { apiKey: key } });
      setData(d);
      setChatId(d.settings.telegram_chat_id ?? "");
      setLead(d.settings.default_lead_minutes ?? 15);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Не удалось загрузить", { description: msg });
      if (msg.includes("Invalid API key")) {
        localStorage.removeItem(KEY_STORAGE);
        setApiKey("");
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (apiKey) load(apiKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

  const submitKey = (e: React.FormEvent) => {
    e.preventDefault();
    if (!keyInput.trim()) return;
    localStorage.setItem(KEY_STORAGE, keyInput.trim());
    setApiKey(keyInput.trim());
  };

  const onSaveSettings = async () => {
    try {
      await saveSettings({
        data: {
          apiKey,
          telegram_chat_id: chatId.trim() || null,
          default_lead_minutes: lead,
        },
      });
      toast.success("Настройки сохранены");
      load(apiKey);
    } catch (e) {
      toast.error("Ошибка", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const onDelete = async (id: string) => {
    if (!confirm("Удалить задачу?")) return;
    await removeTask({ data: { apiKey, id } });
    load(apiKey);
  };

  const onToggle = async (id: string, completed: boolean) => {
    await toggleTask({ data: { apiKey, id, completed } });
    load(apiKey);
  };

  const onTrigger = async () => {
    try {
      const r = await triggerNotify({ data: { apiKey } });
      toast.success("Cron запущен", { description: JSON.stringify(r) });
      load(apiKey);
    } catch (e) {
      toast.error("Ошибка", { description: e instanceof Error ? e.message : String(e) });
    }
  };

  const sortedTasks = useMemo(() => {
    if (!data) return [];
    return [...data.tasks].sort((a, b) => {
      if (a.completed !== b.completed) return a.completed ? 1 : -1;
      const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity;
      const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity;
      return ad - bd;
    });
  }, [data]);

  if (!apiKey) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Toaster />
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Obsidian Tasks Dashboard</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={submitKey} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="key">Plugin API Key</Label>
                <Input
                  id="key"
                  type="password"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder="вставь PLUGIN_API_KEY"
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">
                  Тот же ключ, что в настройках плагина Obsidian.
                </p>
              </div>
              <Button type="submit" className="w-full">
                Войти
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background p-4 md:p-8">
      <Toaster />
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Obsidian Tasks</h1>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => load(apiKey)} disabled={loading}>
              {loading ? "..." : "Обновить"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                localStorage.removeItem(KEY_STORAGE);
                setApiKey("");
                setData(null);
              }}
            >
              Выйти
            </Button>
          </div>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Настройки</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="chat">Telegram chat ID</Label>
                <Input
                  id="chat"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="напиши /start боту, чтобы заполнилось"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lead">Опережение по умолчанию (минут)</Label>
                <Input
                  id="lead"
                  type="number"
                  min={0}
                  value={lead}
                  onChange={(e) => setLead(parseInt(e.target.value) || 0)}
                />
              </div>
            </div>
            <div className="flex gap-2">
              <Button onClick={onSaveSettings}>Сохранить</Button>
              <Button variant="secondary" onClick={onTrigger}>
                Запустить cron сейчас
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Задачи ({data?.tasks.length ?? 0})</CardTitle>
          </CardHeader>
          <CardContent>
            {sortedTasks.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Пусто. Засинхронь из плагина Obsidian.
              </p>
            ) : (
              <div className="space-y-2">
                {sortedTasks.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t as Task}
                    onDelete={() => onDelete(t.id)}
                    onToggle={(c) => onToggle(t.id, c)}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Лог отправок</CardTitle>
          </CardHeader>
          <CardContent>
            {(data?.log.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">Пока ничего не отправлялось.</p>
            ) : (
              <div className="space-y-1 font-mono text-xs">
                {data!.log.map((l) => (
                  <div key={l.id} className="flex gap-2">
                    <span className="text-muted-foreground">
                      {new Date(l.sent_at).toLocaleString("ru-RU")}
                    </span>
                    <Badge variant={l.status === "sent" ? "default" : "destructive"}>
                      {l.status}
                    </Badge>
                    <span>{l.task_title}</span>
                    {l.error && <span className="text-destructive">— {l.error}</span>}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API для плагина</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="font-semibold">Sync URL:</span>{" "}
              <code className="rounded bg-muted px-1">
                {typeof window !== "undefined" ? window.location.origin : ""}
                /api/public/tasks/sync
              </code>
            </p>
            <p>
              <span className="font-semibold">Header:</span>{" "}
              <code className="rounded bg-muted px-1">x-api-key: {"<твой PLUGIN_API_KEY>"}</code>
            </p>
            <p className="text-muted-foreground">
              Body:{" "}
              <code className="rounded bg-muted px-1">
                {`{ "mode": "push" | "full", "tasks": [{"obsidian_id","title","due_at","notify_minutes_before","completed","vault_path"}] }`}
              </code>
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function TaskRow({
  task,
  onDelete,
  onToggle,
}: {
  task: Task;
  onDelete: () => void;
  onToggle: (completed: boolean) => void;
}) {
  const due = task.due_at ? new Date(task.due_at) : null;
  const overdue = due && !task.completed && due.getTime() < Date.now();
  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      <input
        type="checkbox"
        checked={task.completed}
        onChange={(e) => onToggle(e.target.checked)}
        className="h-4 w-4"
      />
      <div className="flex-1 min-w-0">
        <div
          className={`truncate font-medium ${task.completed ? "line-through text-muted-foreground" : ""}`}
        >
          {task.title}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {due && (
            <Badge variant={overdue ? "destructive" : "secondary"}>
              {due.toLocaleString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </Badge>
          )}
          <span>−{task.notify_minutes_before} мин</span>
          {task.notified_at && <Badge variant="outline">пуш отправлен</Badge>}
          {task.vault_path && <span className="truncate">📄 {task.vault_path}</span>}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onDelete}>
        ✕
      </Button>
    </div>
  );
}
