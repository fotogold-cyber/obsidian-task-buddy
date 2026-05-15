import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  requestUrl,
  Platform,
} from "obsidian";
import {
  ViewPlugin,
  ViewUpdate,
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";

/* ============================================================
 * Settings
 * ============================================================ */

interface TBSettings {
  apiBase: string;        // e.g. https://obsidian-task-buddy.lovable.app
  apiKey: string;         // PLUGIN_API_KEY
  defaultLeadMinutes: number;
  fullSyncIntervalMin: number;
  enableLog: boolean;
  logFile: string;        // path within vault
}

const DEFAULT_SETTINGS: TBSettings = {
  apiBase: "https://obsidian-task-buddy.lovable.app",
  apiKey: "",
  defaultLeadMinutes: 15,
  fullSyncIntervalMin: 30,
  enableLog: false,
  logFile: "TaskBuddy-log.md",
};

/* ============================================================
 * Types
 * ============================================================ */

interface ParsedTask {
  obsidianId: string;     // stable id: `${vaultPath}#L${line}` + hash of text fallback
  title: string;
  completed: boolean;
  dueAt: string | null;          // ISO
  notifyMinutesBefore: number;
  vaultPath: string;
  line: number;
  rawLine: string;
}

/* line meta block we append at end of checklist line:
   - [ ] Task text  <!--tb:{"d":"2026-05-15T15:00:00.000Z","m":15,"id":"abc"}-->
*/
const META_RE = /<!--tb:(\{[^}]*\})-->/;
const CHECK_RE = /^(\s*)([-*+])\s\[( |x|X)\]\s+(.*)$/;

/* ============================================================
 * Plugin
 * ============================================================ */

export default class TaskBuddyPlugin extends Plugin {
  settings: TBSettings = DEFAULT_SETTINGS;
  private fullSyncTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new TBSettingsTab(this.app, this));

    // Click handler — work in both Reading and Live Preview / Source modes.
    this.registerDomEvent(document, "click", this.onDocumentClick);

    // CM6 extension: hide <!--tb:...--> meta and render a clickable ⋯ / 🔔 widget
    this.registerEditorExtension(buildTaskBuddyCMExtension(this));

    // Command: open scheduler for current line
    this.addCommand({
      id: "schedule-task-current-line",
      name: "Запланировать напоминание для задачи (текущая строка)",
      editorCallback: (editor: Editor, view: MarkdownView) => {
        this.openSchedulerForEditorLine(editor, view);
      },
    });

    // Command: full sync now
    this.addCommand({
      id: "full-sync-now",
      name: "Синхронизировать все задачи сейчас",
      callback: () => this.fullSync(true),
    });

    // Periodic full-sync
    this.scheduleFullSync();

    // Initial sync on load (delayed so vault is ready)
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => this.fullSync(false), 3000);
    });
  }

  onunload() {
    if (this.fullSyncTimer) window.clearInterval(this.fullSyncTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
  }

  private scheduleFullSync() {
    if (this.fullSyncTimer) window.clearInterval(this.fullSyncTimer);
    const ms = Math.max(5, this.settings.fullSyncIntervalMin) * 60 * 1000;
    this.fullSyncTimer = window.setInterval(() => this.fullSync(false), ms);
  }

  /* ----------------------------- Click handler ----------------------------- */

  private onDocumentClick = (evt: MouseEvent) => {
    const target = evt.target as HTMLElement | null;
    if (!target) return;

    // ⋯ widget handles itself (see CM6 extension); ignore here to avoid double-open.
    if (target.closest(".tb-meta-dots")) return;

    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file) return;
    const file = view.file;

    // Never open scheduler when user clicks the checkbox itself — that toggles done.
    if (target.closest("input.task-list-item-checkbox")) return;

    // Open scheduler only when clicking the task text (Reading mode <li class="task-list-item">).
    const li = target.closest<HTMLElement>("li.task-list-item");
    if (li) {
      // ignore link clicks etc.
      if (target.closest("a")) return;
      const cb = li.querySelector<HTMLInputElement>("input.task-list-item-checkbox");
      const lineAttr = li.getAttribute("data-line") || cb?.getAttribute("data-line") || null;
      const line = lineAttr ? parseInt(lineAttr, 10) : null;
      if (line == null || isNaN(line)) return;
      this.openSchedulerForLine(file, line);
      return;
    }
  };

  private findLineForCheckbox(view: MarkdownView, _cb: HTMLInputElement): number | null {
    const editor = view.editor;
    if (editor) return editor.getCursor().line;
    return null;
  }

  /* --------------------------- Scheduler entrypoints ----------------------- */

  private async openSchedulerForEditorLine(editor: Editor, view: MarkdownView) {
    const file = view.file;
    if (!file) return;
    const line = editor.getCursor().line;
    await this.openSchedulerForLine(file, line);
  }

  async openSchedulerForLine(file: TFile, line: number) {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const raw = lines[line] ?? "";
    const m = raw.match(CHECK_RE);
    if (!m) return; // not a checklist line

    const parsed = this.parseLine(file.path, line, raw);
    new ScheduleSheet(this.app, parsed, async (result) => {
      if (result.action === "cancel") return;
      let newLine = raw;

      if (result.action === "delete") {
        newLine = this.stripMeta(raw);
      } else {
        const meta = {
          d: result.dueAt,
          m: result.notifyMinutesBefore ?? this.settings.defaultLeadMinutes,
          id: parsed.obsidianId,
        };
        const stripped = this.stripMeta(raw).replace(/\s+$/, "");
        newLine = `${stripped} <!--tb:${JSON.stringify(meta)}-->`;
      }

      lines[line] = newLine;
      await this.app.vault.modify(file, lines.join("\n"));

      // Push immediately
      const updated = this.parseLine(file.path, line, newLine);
      if (result.action === "delete") {
        await this.pushDelete(parsed.obsidianId);
      } else {
        await this.pushTasks([updated], "push");
      }
    }).open();
  }

  /* ------------------------------ Parsing ---------------------------------- */

  private stripMeta(line: string): string {
    return line.replace(META_RE, "").replace(/\s+$/, "");
  }

  private parseLine(vaultPath: string, line: number, raw: string): ParsedTask {
    const m = raw.match(CHECK_RE);
    const completed = !!m && (m[3] === "x" || m[3] === "X");
    let titlePart = m ? m[4] : raw;

    let dueAt: string | null = null;
    let notify = this.settings.defaultLeadMinutes;
    let id = `${vaultPath}#L${line}`;

    const meta = raw.match(META_RE);
    if (meta) {
      try {
        const j = JSON.parse(meta[1]);
        if (typeof j.d === "string") dueAt = j.d;
        if (typeof j.m === "number") notify = j.m;
        if (typeof j.id === "string") id = j.id;
      } catch (_) { /* ignore */ }
      titlePart = titlePart.replace(META_RE, "").trim();
    }

    return {
      obsidianId: id,
      title: titlePart.trim() || "(без названия)",
      completed,
      dueAt,
      notifyMinutesBefore: notify,
      vaultPath,
      line,
      rawLine: raw,
    };
  }

  /* ------------------------------ Sync ------------------------------------- */

  async fullSync(showNotice: boolean) {
    if (!this.settings.apiKey) {
      if (showNotice) new Notice("Task Buddy: укажи API key в настройках");
      return;
    }
    try {
      const tasks: ParsedTask[] = [];
      const mdFiles = this.app.vault.getMarkdownFiles();
      for (const f of mdFiles) {
        const content = await this.app.vault.cachedRead(f);
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const m = lines[i].match(CHECK_RE);
          if (!m) continue;
          // Only sync tasks that have a reminder set OR are uncompleted (so server knows about them)
          const t = this.parseLine(f.path, i, lines[i]);
          if (t.dueAt) tasks.push(t);
        }
      }
      const res = await this.pushTasks(tasks, "full");
      if (showNotice) new Notice(`Task Buddy: синхронизировано ${tasks.length} задач${res ? "" : " (с ошибкой)"}`);
    } catch (e) {
      console.error("[TaskBuddy] full sync failed", e);
      if (showNotice) new Notice("Task Buddy: ошибка full-sync, см. консоль");
    }
  }

  private async pushTasks(tasks: ParsedTask[], mode: "push" | "full"): Promise<boolean> {
    if (!this.settings.apiKey) {
      new Notice("Task Buddy: нет API key");
      return false;
    }
    const url = `${this.settings.apiBase.replace(/\/$/, "")}/api/public/tasks/sync`;
    try {
      const resp = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.settings.apiKey,
        },
        body: JSON.stringify({
          mode,
          client: Platform.isMobile ? "obsidian-mobile" : "obsidian-desktop",
          tasks: tasks.map((t) => ({
            obsidian_id: t.obsidianId,
            title: t.title,
            completed: t.completed,
            due_at: t.dueAt,
            notify_minutes_before: t.notifyMinutesBefore,
            vault_path: t.vaultPath,
            vault_name: this.app.vault.getName(),
          })),
        }),
        throw: false,
      });
      if (resp.status >= 200 && resp.status < 300) return true;
      console.error("[TaskBuddy] sync HTTP", resp.status, resp.text);
      return false;
    } catch (e) {
      console.error("[TaskBuddy] sync error", e);
      return false;
    }
  }

  private async pushDelete(obsidianId: string): Promise<boolean> {
    const url = `${this.settings.apiBase.replace(/\/$/, "")}/api/public/tasks/sync`;
    try {
      const resp = await requestUrl({
        url,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.settings.apiKey,
        },
        body: JSON.stringify({
          mode: "push",
          tasks: [{ obsidian_id: obsidianId, _delete: true }],
        }),
        throw: false,
      });
      return resp.status >= 200 && resp.status < 300;
    } catch (e) {
      console.error("[TaskBuddy] delete error", e);
      return false;
    }
  }
}

/* ============================================================
 * Bottom sheet UI (looks like Google Tasks)
 * ============================================================ */

type SheetResult =
  | { action: "save"; dueAt: string; notifyMinutesBefore: number }
  | { action: "delete" }
  | { action: "cancel" };

class ScheduleSheet {
  private overlay!: HTMLDivElement;
  private timeInput!: HTMLInputElement;
  private dateInput!: HTMLInputElement;
  private leadInput!: HTMLInputElement;
  private chosenDate: Date | null = null;

  constructor(
    private app: App,
    private task: ParsedTask,
    private onClose: (r: SheetResult) => void,
  ) {}

  open() {
    this.overlay = document.createElement("div");
    this.overlay.className = "tb-sheet-overlay" + (Platform.isMobile ? " is-mobile" : "");
    this.overlay.addEventListener("click", (e) => {
      if (e.target === this.overlay) this.close({ action: "cancel" });
    });

    const sheet = document.createElement("div");
    sheet.className = "tb-sheet";

    const title = document.createElement("div");
    title.className = "tb-sheet-title";
    title.textContent = this.task.title;
    sheet.appendChild(title);

    // Quick chips: Today / Tomorrow / Clock
    const chips = document.createElement("div");
    chips.className = "tb-chips";

    const todayChip = this.makeChip("Сегодня", () => this.pickQuick("today"));
    const tomorrowChip = this.makeChip("Завтра", () => this.pickQuick("tomorrow"));
    const clockChip = this.makeChip("🕒", () => this.showFullPicker());
    clockChip.classList.add("tb-chip-icon");
    clockChip.title = "Выбрать дату и время";

    chips.appendChild(todayChip);
    chips.appendChild(tomorrowChip);
    chips.appendChild(clockChip);
    sheet.appendChild(chips);

    // Pickers (hidden until needed)
    const pickerWrap = document.createElement("div");
    pickerWrap.style.display = "none";
    pickerWrap.dataset.role = "picker";

    const dateRow = document.createElement("div");
    dateRow.className = "tb-row";
    const dateLabel = document.createElement("label");
    dateLabel.textContent = "Дата";
    this.dateInput = document.createElement("input");
    this.dateInput.type = "date";
    dateRow.appendChild(dateLabel);
    dateRow.appendChild(this.dateInput);

    const timeRow = document.createElement("div");
    timeRow.className = "tb-row";
    const timeLabel = document.createElement("label");
    timeLabel.textContent = "Время";
    this.timeInput = document.createElement("input");
    this.timeInput.type = "time";
    timeRow.appendChild(timeLabel);
    timeRow.appendChild(this.timeInput);

    const leadRow = document.createElement("div");
    leadRow.className = "tb-row";
    const leadLabel = document.createElement("label");
    leadLabel.textContent = "Алерт за (мин)";
    this.leadInput = document.createElement("input");
    this.leadInput.type = "number";
    this.leadInput.min = "0";
    this.leadInput.value = String(this.task.notifyMinutesBefore ?? 15);
    leadRow.appendChild(leadLabel);
    leadRow.appendChild(this.leadInput);

    pickerWrap.appendChild(dateRow);
    pickerWrap.appendChild(timeRow);
    pickerWrap.appendChild(leadRow);
    sheet.appendChild(pickerWrap);

    // Pre-fill if task already had a reminder
    if (this.task.dueAt) {
      const d = new Date(this.task.dueAt);
      this.chosenDate = d;
      this.dateInput.value = this.toDateInput(d);
      this.timeInput.value = this.toTimeInput(d);
      pickerWrap.style.display = "block";
    }

    // Actions
    const actions = document.createElement("div");
    actions.className = "tb-actions";

    const delBtn = document.createElement("button");
    delBtn.className = "tb-btn tb-btn-danger";
    delBtn.textContent = "🗑";
    delBtn.title = "Удалить напоминание";
    delBtn.onclick = () => this.close({ action: "delete" });

    const right = document.createElement("div");
    right.style.display = "flex";
    right.style.gap = "4px";

    const cancelBtn = document.createElement("button");
    cancelBtn.className = "tb-btn tb-btn-ghost";
    cancelBtn.textContent = "Отмена";
    cancelBtn.onclick = () => this.close({ action: "cancel" });

    const saveBtn = document.createElement("button");
    saveBtn.className = "tb-btn tb-btn-primary";
    saveBtn.textContent = "Готово";
    saveBtn.onclick = () => this.commit();

    right.appendChild(cancelBtn);
    right.appendChild(saveBtn);

    actions.appendChild(delBtn);
    actions.appendChild(right);
    sheet.appendChild(actions);

    this.overlay.appendChild(sheet);
    document.body.appendChild(this.overlay);
  }

  private makeChip(label: string, cb: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = "tb-chip";
    b.textContent = label;
    b.onclick = cb;
    return b;
  }

  private pickQuick(which: "today" | "tomorrow") {
    const d = new Date();
    if (which === "tomorrow") d.setDate(d.getDate() + 1);
    // default time = next round hour
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    this.chosenDate = d;
    this.dateInput.value = this.toDateInput(d);
    this.timeInput.value = this.toTimeInput(d);
    const wrap = this.overlay.querySelector<HTMLElement>('[data-role="picker"]');
    if (wrap) wrap.style.display = "block";
    // Focus time field — it's the main thing to confirm for "today/tomorrow"
    window.setTimeout(() => this.timeInput.focus(), 50);
  }

  private showFullPicker() {
    if (!this.chosenDate) {
      const d = new Date();
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() + 1);
      this.chosenDate = d;
      this.dateInput.value = this.toDateInput(d);
      this.timeInput.value = this.toTimeInput(d);
    }
    const wrap = this.overlay.querySelector<HTMLElement>('[data-role="picker"]');
    if (wrap) wrap.style.display = "block";
    window.setTimeout(() => this.dateInput.focus(), 50);
  }

  private commit() {
    const dStr = this.dateInput.value;
    const tStr = this.timeInput.value || "09:00";
    if (!dStr) {
      new Notice("Выбери дату");
      return;
    }
    const [y, mo, da] = dStr.split("-").map(Number);
    const [h, mi] = tStr.split(":").map(Number);
    const local = new Date(y, (mo || 1) - 1, da || 1, h || 0, mi || 0, 0, 0);
    const lead = parseInt(this.leadInput.value || "15", 10);
    this.close({
      action: "save",
      dueAt: local.toISOString(),
      notifyMinutesBefore: isNaN(lead) ? 15 : lead,
    });
  }

  private close(r: SheetResult) {
    this.overlay.remove();
    this.onClose(r);
  }

  private toDateInput(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }
  private toTimeInput(d: Date): string {
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    return `${h}:${m}`;
  }
}

/* ============================================================
 * Settings tab
 * ============================================================ */

class TBSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: TaskBuddyPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Task Buddy — настройки" });

    new Setting(containerEl)
      .setName("API base URL")
      .setDesc("URL твоего бэка (Lovable Cloud).")
      .addText((t) =>
        t.setValue(this.plugin.settings.apiBase).onChange(async (v) => {
          this.plugin.settings.apiBase = v.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("API key")
      .setDesc("PLUGIN_API_KEY из бэка.")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setValue(this.plugin.settings.apiKey).onChange(async (v) => {
          this.plugin.settings.apiKey = v.trim();
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Алерт по умолчанию (мин)")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.defaultLeadMinutes))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.defaultLeadMinutes = isNaN(n) ? 15 : n;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Полный sync каждые (мин)")
      .addText((t) =>
        t
          .setValue(String(this.plugin.settings.fullSyncIntervalMin))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            this.plugin.settings.fullSyncIntervalMin = isNaN(n) ? 30 : n;
            await this.plugin.saveSettings();
            (this.plugin as any).scheduleFullSync();
          }),
      );

    new Setting(containerEl)
      .setName("Запустить full-sync сейчас")
      .addButton((b) =>
        b.setButtonText("Sync").onClick(() => this.plugin.fullSync(true)),
      );
  }
}

/* ============================================================
 * CodeMirror 6 extension: hide <!--tb:...--> meta and render a
 * clickable widget at end of every checklist line.
 * ============================================================ */

class DotsWidget extends WidgetType {
  constructor(
    private readonly hasReminder: boolean,
    private readonly onClick: () => void,
  ) {
    super();
  }
  eq(other: DotsWidget): boolean {
    return other.hasReminder === this.hasReminder;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "tb-meta-dots" + (this.hasReminder ? " tb-meta-dots-active" : "");
    span.textContent = this.hasReminder ? "🔔" : "⋯";
    span.setAttribute("contenteditable", "false");
    span.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    span.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick();
    });
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

function buildTaskBuddyCMExtension(plugin: TaskBuddyPlugin) {
  const decorate = (view: EditorView): DecorationSet => {
    const builder = new RangeSetBuilder<Decoration>();
    const doc = view.state.doc;
    for (const { from, to } of view.visibleRanges) {
      let pos = from;
      while (pos <= to) {
        const line = doc.lineAt(pos);
        const text = line.text;
        const taskMatch = text.match(CHECK_RE);
        if (taskMatch) {
          // 1) Hide the meta comment, if present
          const metaMatch = META_RE.exec(text);
          let hasReminder = false;
          if (metaMatch && typeof metaMatch.index === "number") {
            hasReminder = true;
            const metaIdx = metaMatch.index;
            const start = line.from + metaIdx;
            const end = start + metaMatch[0].length;
            // Also swallow a single leading space so we don't leave a trailing gap.
            const leading = metaIdx > 0 && text[metaIdx - 1] === " " ? 1 : 0;
            builder.add(start - leading, end, Decoration.replace({}));
          }

          // 2) Append a ⋯ / 🔔 widget at the end of the line
          const lineNumber = line.number - 1; // CM is 1-indexed, Obsidian editor is 0-indexed
          builder.add(
            line.to,
            line.to,
            Decoration.widget({
              widget: new DotsWidget(hasReminder, () => {
                const mdView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
                const file = mdView?.file;
                if (file) plugin.openSchedulerForLine(file, lineNumber);
              }),
              side: 1,
            }),
          );
        }
        pos = line.to + 1;
      }
    }
    return builder.finish();
  };

  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = decorate(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || u.selectionSet) {
          this.decorations = decorate(u.view);
        }
      }
    },
    { decorations: (v) => v.decorations },
  );
}
