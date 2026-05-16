/**
 * Skills command — /memory-skills opens an interactive skills manager.
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { SkillStore } from "../store/skill-store.js";
import type { SkillIndex, SkillResult, SkillScope } from "../types.js";
import {
  Input,
  Key,
  fuzzyFilter,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";

export const MEMORY_SKILLS_KEYMAP = {
  moveGlobal: "g",
  moveProject: "p",
  deleteSelected: "d",
  selectAllFiltered: "a",
  clearSelection: "n",
  focusSearch: "/",
  toggleSelection: "space",
  switchFocus: "tab",
  close: "esc",
} as const;

export interface SkillModalRow {
  skillId: string;
  scope: SkillScope;
  name: string;
  displayName: string;
  description: string;
  path: string;
  projectName?: string;
  selected: boolean;
  searchText: string;
}

export interface SkillBatchActionResult {
  skills: SkillIndex[];
  summaryLines: string[];
  retainSelectedSkillIds?: string[];
  focusSkillId?: string;
}

export function formatSkillsList(skills: SkillIndex[], projectName: string | null): string {
  const globalSkills = skills.filter((skill) => skill.scope === "global");
  const projectSkills = skills.filter((skill) => skill.scope === "project");

  const lines: string[] = [];
  lines.push("");
  lines.push("  ╔══════════════════════════════════════════════╗");
  lines.push("  ║            🧠 Procedural Skills             ║");
  lines.push("  ╚══════════════════════════════════════════════╝");
  lines.push("");

  if (skills.length === 0) {
    lines.push("  (no skills created yet)");
    lines.push("");
    lines.push("  Skills are auto-created after complex tasks,");
    lines.push("  or you can ask the agent to create one.");
    return lines.join("\n");
  }

  if (globalSkills.length > 0) {
    lines.push("  Global Skills");
    lines.push("  ─────────────");
    for (const skill of globalSkills) {
      lines.push(`  📄 ${skill.displayName || skill.name}`);
      lines.push(`     ${skill.description}`);
      lines.push(`     id: ${skill.skillId}`);
      lines.push(`     path: ${skill.path}`);
      lines.push("");
    }
  }

  if (projectSkills.length > 0) {
    lines.push(`  Project Skills${projectName ? ` (${projectName})` : ""}`);
    lines.push("  ──────────────");
    for (const skill of projectSkills) {
      lines.push(`  📄 ${skill.displayName || skill.name}`);
      lines.push(`     ${skill.description}`);
      lines.push(`     id: ${skill.skillId}`);
      lines.push(`     path: ${skill.path}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

export function buildSkillRows(skills: SkillIndex[], selectedSkillIds = new Set<string>()): SkillModalRow[] {
  return skills.map((skill) => ({
    skillId: skill.skillId,
    scope: skill.scope,
    name: skill.name,
    displayName: skill.displayName || skill.name,
    description: skill.description,
    path: skill.path,
    projectName: skill.projectName,
    selected: selectedSkillIds.has(skill.skillId),
    searchText: `${skill.displayName || skill.name} ${skill.name}`.trim(),
  }));
}

export function filterSkillRows(rows: SkillModalRow[], query: string): SkillModalRow[] {
  const trimmed = query.trim();
  if (!trimmed) return rows;
  return fuzzyFilter(rows, trimmed, (row) => row.searchText);
}

export function getSelectedSkillIds(rows: SkillModalRow[]): string[] {
  return rows.filter((row) => row.selected).map((row) => row.skillId);
}

function summarizeAction(
  actionVerb: string,
  targetLabel: string,
  successes: SkillResult[],
  unchanged: SkillResult[],
  blocked: Array<{ skillId: string; error: string }>,
): string[] {
  const lines: string[] = [];
  const changed = successes.filter((result) => result.message?.includes(actionVerb) || result.skillId);

  if (actionVerb === "moved") {
    lines.push(`Moved ${successes.length} skill${successes.length === 1 ? "" : "s"} to ${targetLabel}.`);
  } else if (actionVerb === "deleted") {
    lines.push(`Deleted ${successes.length} skill${successes.length === 1 ? "" : "s"}.`);
  } else {
    lines.push(`${changed.length} skill action(s) completed.`);
  }

  if (unchanged.length > 0) {
    lines.push(`${unchanged.length} already matched the target scope.`);
  }

  if (blocked.length > 0) {
    lines.push(`Blocked ${blocked.length} skill${blocked.length === 1 ? "" : "s"}:`);
    for (const item of blocked.slice(0, 4)) {
      lines.push(`- ${item.skillId}: ${item.error}`);
    }
    if (blocked.length > 4) {
      lines.push(`- …and ${blocked.length - 4} more`);
    }
  }

  return lines;
}

type SkillMoveStore = Pick<SkillStore, "move" | "loadIndex" | "getProjectName">;
type SkillDeleteStore = Pick<SkillStore, "delete" | "loadIndex">;
export type ConfirmDialog = (title: string, message: string) => Promise<boolean>;

export async function moveSelectedSkills(
  store: SkillMoveStore,
  skillIds: string[],
  targetScope: SkillScope,
): Promise<SkillBatchActionResult> {
  const dedupedSkillIds = Array.from(new Set(skillIds));
  const currentSkills = await store.loadIndex();

  if (dedupedSkillIds.length === 0) {
    return {
      skills: currentSkills,
      summaryLines: ["Select one or more skills first."],
    };
  }

  if (targetScope === "project" && !store.getProjectName()) {
    return {
      skills: currentSkills,
      summaryLines: ["Move to project is unavailable: no active project detected."],
      retainSelectedSkillIds: dedupedSkillIds,
    };
  }

  const successes: SkillResult[] = [];
  const unchanged: SkillResult[] = [];
  const blocked: Array<{ skillId: string; error: string }> = [];

  for (const skillId of dedupedSkillIds) {
    try {
      const result = await store.move(skillId, targetScope);
      if (result.success) {
        if (result.skillId === skillId && result.scope === targetScope) {
          unchanged.push(result);
        } else {
          successes.push(result);
        }
      } else {
        blocked.push({ skillId, error: result.error || "Unknown move failure." });
      }
    } catch (error) {
      blocked.push({
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refreshedSkills = await store.loadIndex();
  const focusSkillId = blocked[0]?.skillId
    ?? successes[0]?.skillId
    ?? unchanged[0]?.skillId;

  return {
    skills: refreshedSkills,
    summaryLines: summarizeAction("moved", targetScope, successes, unchanged, blocked),
    retainSelectedSkillIds: blocked.map((item) => item.skillId),
    focusSkillId,
  };
}

export async function deleteSelectedSkills(
  store: SkillDeleteStore,
  skillIds: string[],
): Promise<SkillBatchActionResult> {
  const dedupedSkillIds = Array.from(new Set(skillIds));
  const currentSkills = await store.loadIndex();

  if (dedupedSkillIds.length === 0) {
    return {
      skills: currentSkills,
      summaryLines: ["Select one or more skills first."],
    };
  }

  const successes: SkillResult[] = [];
  const blocked: Array<{ skillId: string; error: string }> = [];

  for (const skillId of dedupedSkillIds) {
    try {
      const result = await store.delete(skillId);
      if (result.success) {
        successes.push(result);
      } else {
        blocked.push({ skillId, error: result.error || "Unknown delete failure." });
      }
    } catch (error) {
      blocked.push({
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const refreshedSkills = await store.loadIndex();

  return {
    skills: refreshedSkills,
    summaryLines: summarizeAction("deleted", "delete", successes, [], blocked),
    retainSelectedSkillIds: blocked.map((item) => item.skillId),
    focusSkillId: blocked[0]?.skillId,
  };
}

export async function confirmDeleteSelectedSkills(
  confirm: ConfirmDialog,
  store: SkillDeleteStore,
  skillIds: string[],
): Promise<SkillBatchActionResult> {
  const currentSkills = await store.loadIndex();
  if (skillIds.length === 0) {
    return { skills: currentSkills, summaryLines: ["Select one or more skills first."] };
  }

  const confirmed = await confirm(
    "Delete selected skills?",
    `Delete ${skillIds.length} selected skill${skillIds.length === 1 ? "" : "s"}? This cannot be undone.`,
  );

  if (!confirmed) {
    return {
      skills: currentSkills,
      summaryLines: ["Delete cancelled."],
      retainSelectedSkillIds: skillIds,
      focusSkillId: skillIds[0],
    };
  }

  return deleteSelectedSkills(store, skillIds);
}

interface SkillsManagerCallbacks {
  moveSelected: (scope: SkillScope, skillIds: string[]) => Promise<SkillBatchActionResult>;
  deleteSelected: (skillIds: string[]) => Promise<SkillBatchActionResult>;
  close: () => void;
  projectName: string | null;
}

export class SkillsManagerModal implements Focusable {
  private _focused = false;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.syncSearchFocus();
  }

  private readonly searchInput = new Input();
  private rows: SkillModalRow[];
  private selectedIndex = 0;
  private query = "";
  private focusArea: "search" | "list" = "list";
  private busy = false;
  private closed = false;
  private pendingDeleteConfirm: { skillIds: string[] } | null = null;
  private summaryLines: string[] = [
    "Select skills with space, then move with g/p or delete with d.",
  ];

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    initialRows: SkillModalRow[],
    private readonly callbacks: SkillsManagerCallbacks,
  ) {
    this.rows = initialRows;
    this.syncSearchFocus();
  }

  invalidate(): void {
    this.searchInput.invalidate();
  }

  private get filteredRows(): SkillModalRow[] {
    return filterSkillRows(this.rows, this.query);
  }

  private getCurrentRow(): SkillModalRow | null {
    const rows = this.filteredRows;
    if (rows.length === 0) return null;
    return rows[Math.min(this.selectedIndex, rows.length - 1)] ?? null;
  }

  private getSelectedIds(): string[] {
    return getSelectedSkillIds(this.rows);
  }

  private syncSearchFocus(): void {
    this.searchInput.focused = this.focused && this.focusArea === "search";
  }

  private syncQueryFromInput(): void {
    this.query = this.searchInput.getValue();
    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
    }
  }

  private setFocusArea(area: "search" | "list"): void {
    this.focusArea = area;
    this.syncSearchFocus();
    this.tui.requestRender();
  }

  private setRows(skills: SkillIndex[], retainSelectedSkillIds: string[] = [], focusSkillId?: string): void {
    this.rows = buildSkillRows(skills, new Set(retainSelectedSkillIds));
    this.syncQueryFromInput();

    const rows = this.filteredRows;
    if (rows.length === 0) {
      this.selectedIndex = 0;
      return;
    }

    if (focusSkillId) {
      const focusIndex = rows.findIndex((row) => row.skillId === focusSkillId);
      if (focusIndex >= 0) {
        this.selectedIndex = focusIndex;
        return;
      }
    }

    this.selectedIndex = Math.min(this.selectedIndex, rows.length - 1);
  }

  private toggleSelected(skillId: string): void {
    const row = this.rows.find((entry) => entry.skillId === skillId);
    if (!row) return;
    row.selected = !row.selected;
  }

  private toggleCurrentSelection(): void {
    const row = this.getCurrentRow();
    if (!row) return;
    this.toggleSelected(row.skillId);
    this.summaryLines = [
      `${row.selected ? "Selected" : "Cleared"} ${row.displayName}.`,
    ];
    this.tui.requestRender();
  }

  private selectAllFiltered(): void {
    const rows = this.filteredRows;
    for (const row of rows) {
      row.selected = true;
    }
    this.summaryLines = [
      `Selected ${rows.length} visible skill${rows.length === 1 ? "" : "s"}.`,
    ];
    this.tui.requestRender();
  }

  private clearSelection(): void {
    for (const row of this.rows) {
      row.selected = false;
    }
    this.summaryLines = ["Cleared all selections."];
    this.tui.requestRender();
  }

  private async runMove(targetScope: SkillScope): Promise<void> {
    const selectedIds = this.getSelectedIds();
    await this.runAsyncAction(this.callbacks.moveSelected(targetScope, selectedIds));
  }

  private promptDelete(): void {
    const selectedIds = this.getSelectedIds();
    if (selectedIds.length === 0) {
      this.summaryLines = ["Select one or more skills first."];
      this.tui.requestRender();
      return;
    }

    this.pendingDeleteConfirm = { skillIds: selectedIds };
    this.summaryLines = [
      `Delete ${selectedIds.length} selected skill${selectedIds.length === 1 ? "" : "s"}? Press y to confirm or n to cancel.`,
    ];
    this.tui.requestRender();
  }

  private async runDeleteConfirmed(skillIds: string[]): Promise<void> {
    await this.runAsyncAction(this.callbacks.deleteSelected(skillIds));
  }

  private closeModal(): void {
    if (this.closed) return;
    this.closed = true;
    this.callbacks.close();
  }

  private async runAsyncAction(action: Promise<SkillBatchActionResult>): Promise<void> {
    if (this.closed) return;

    this.busy = true;
    this.summaryLines = ["Applying skill changes…"];
    this.tui.requestRender();

    try {
      const result = await action;
      if (this.closed) return;
      this.setRows(result.skills, result.retainSelectedSkillIds, result.focusSkillId);
      this.summaryLines = result.summaryLines;
    } catch (error) {
      if (!this.closed) {
        this.summaryLines = [error instanceof Error ? error.message : String(error)];
      }
    } finally {
      this.busy = false;
      if (!this.closed) {
        this.tui.requestRender();
      }
    }
  }

  private moveSelection(delta: number): void {
    const rows = this.filteredRows;
    if (rows.length === 0) return;
    const next = this.selectedIndex + delta;
    this.selectedIndex = Math.max(0, Math.min(next, rows.length - 1));
    this.tui.requestRender();
  }

  private pageSelection(delta: number): void {
    const pageSize = Math.max(5, this.getMaxVisibleRows() - 1);
    this.moveSelection(delta * pageSize);
  }

  private getMaxVisibleRows(): number {
    return Math.max(6, Math.min(14, this.tui.terminal.rows - 18));
  }

  private focusSearchWithOptionalInput(data?: string): void {
    this.setFocusArea("search");
    if (data) {
      this.searchInput.handleInput(data);
      this.syncQueryFromInput();
      this.tui.requestRender();
    }
  }

  private isPrintableInput(data: string): boolean {
    return data.length === 1 && data >= " " && data !== "\x7f";
  }

  handleInput(data: string): void {
    if (this.closed) return;

    if (this.busy) {
      if (matchesKey(data, Key.escape)) this.closeModal();
      return;
    }

    if (this.pendingDeleteConfirm) {
      if (data === "y" || data === "Y") {
        const pending = this.pendingDeleteConfirm;
        this.pendingDeleteConfirm = null;
        void this.runDeleteConfirmed(pending.skillIds);
        return;
      }

      if (data === "n" || data === "N" || matchesKey(data, Key.escape)) {
        this.pendingDeleteConfirm = null;
        this.summaryLines = ["Delete cancelled."];
        this.tui.requestRender();
      }
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.closeModal();
      return;
    }

    if (this.focusArea === "search") {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) {
        this.setFocusArea("list");
        return;
      }

      this.searchInput.handleInput(data);
      this.syncQueryFromInput();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.slash)) {
      this.focusSearchWithOptionalInput();
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.pageSelection(-1);
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.pageSelection(1);
      return;
    }
    if (matchesKey(data, Key.home)) {
      this.selectedIndex = 0;
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.end)) {
      this.selectedIndex = Math.max(0, this.filteredRows.length - 1);
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.space)) {
      this.toggleCurrentSelection();
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.selectAllFiltered) {
      this.selectAllFiltered();
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.clearSelection) {
      this.clearSelection();
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.moveGlobal) {
      void this.runMove("global");
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.moveProject) {
      void this.runMove("project");
      return;
    }
    if (data === MEMORY_SKILLS_KEYMAP.deleteSelected) {
      this.promptDelete();
      return;
    }
    if (this.isPrintableInput(data) && !["g", "p", "d", "a", "n"].includes(data)) {
      this.focusSearchWithOptionalInput(data);
    }
  }

  private renderFramedLine(content: string, width: number): string {
    const innerWidth = Math.max(10, width - 4);
    const padded = truncateToWidth(content, innerWidth, "");
    const spaces = Math.max(0, innerWidth - visibleWidth(padded));
    return `${this.theme.fg("borderAccent", "│")} ${padded}${" ".repeat(spaces)} ${this.theme.fg("borderAccent", "│")}`;
  }

  private renderWrappedSection(lines: string[], width: number): string[] {
    const rendered: string[] = [];
    const innerWidth = Math.max(10, width - 4);
    for (const line of lines) {
      const wrapped = wrapTextWithAnsi(line, innerWidth);
      if (wrapped.length === 0) {
        rendered.push(this.renderFramedLine("", width));
        continue;
      }
      for (const part of wrapped) {
        rendered.push(this.renderFramedLine(part, width));
      }
    }
    return rendered;
  }

  render(width: number): string[] {
    const safeWidth = Math.max(60, width);
    const top = this.theme.fg("borderAccent", `┌${"─".repeat(Math.max(1, safeWidth - 2))}┐`);
    const bottom = this.theme.fg("borderAccent", `└${"─".repeat(Math.max(1, safeWidth - 2))}┘`);
    const lines: string[] = [top];

    const projectName = this.callbacks.projectName ? ` · project: ${this.callbacks.projectName}` : "";
    const title = this.theme.fg("accent", this.theme.bold(`🧠 Procedural Skills${projectName}`));
    lines.push(this.renderFramedLine(title, safeWidth));

    const searchHint = this.focusArea === "search"
      ? this.theme.fg("accent", "search")
      : this.theme.fg("dim", "search");
    const searchLine = this.searchInput.render(Math.max(10, safeWidth - 17))[0] ?? "";
    lines.push(this.renderFramedLine(`${searchHint}: ${searchLine}`, safeWidth));

    const filteredRows = this.filteredRows;
    const selectedCount = this.getSelectedIds().length;
    lines.push(this.renderFramedLine(
      this.theme.fg(
        "dim",
        `${filteredRows.length} visible · ${this.rows.length} total · ${selectedCount} selected${this.busy ? " · working…" : ""}`,
      ),
      safeWidth,
    ));

    lines.push(this.renderFramedLine("", safeWidth));

    if (filteredRows.length === 0) {
      const emptyMessage = this.rows.length === 0 ? "No skills found yet." : "No skills match the current search.";
      lines.push(this.renderFramedLine(this.theme.fg("warning", emptyMessage), safeWidth));
      lines.push(this.renderFramedLine("", safeWidth));
    } else {
      const maxVisible = this.getMaxVisibleRows();
      const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), filteredRows.length - maxVisible));
      const end = Math.min(filteredRows.length, start + maxVisible);
      const visibleRows = filteredRows.slice(start, end);

      for (let i = 0; i < visibleRows.length; i++) {
        const row = visibleRows[i]!;
        const absoluteIndex = start + i;
        const cursor = absoluteIndex === this.selectedIndex ? this.theme.fg("accent", "›") : " ";
        const check = row.selected ? this.theme.fg("accent", "[x]") : this.theme.fg("dim", "[ ]");
        const scope = row.scope === "global"
          ? this.theme.fg("accent", "[G]")
          : this.theme.fg("warning", "[P]");
        const baseText = `${cursor} ${check} ${scope} ${row.displayName}`;
        const lineText = absoluteIndex === this.selectedIndex
          ? this.theme.bg("selectedBg", truncateToWidth(baseText, Math.max(10, safeWidth - 4), ""))
          : truncateToWidth(baseText, Math.max(10, safeWidth - 4), "");
        lines.push(this.renderFramedLine(lineText, safeWidth));
      }

      if (start > 0 || end < filteredRows.length) {
        lines.push(this.renderFramedLine(this.theme.fg("dim", `Showing ${start + 1}-${end} of ${filteredRows.length}`), safeWidth));
      }

      lines.push(this.renderFramedLine("", safeWidth));
      const currentRow = this.getCurrentRow();
      if (currentRow) {
        lines.push(this.renderFramedLine(this.theme.fg("accent", `Focused: ${currentRow.displayName}`), safeWidth));
        lines.push(...this.renderWrappedSection([
          currentRow.description || "(no description)",
          this.theme.fg("dim", currentRow.skillId),
        ], safeWidth));
      }
    }

    lines.push(this.renderFramedLine("", safeWidth));
    lines.push(this.renderFramedLine(this.theme.fg("accent", "Last action"), safeWidth));
    lines.push(...this.renderWrappedSection(this.summaryLines, safeWidth));
    lines.push(this.renderFramedLine("", safeWidth));

    const help = this.pendingDeleteConfirm
      ? "Confirm delete: y yes · n no · esc cancel"
      : this.callbacks.projectName
        ? "↑↓ move · space select · / search · tab switch · g global · p project · d delete · a all · n none · esc close"
        : "↑↓ move · space select · / search · tab switch · g global · p project (disabled) · d delete · a all · n none · esc close";
    lines.push(this.renderFramedLine(this.theme.fg("dim", help), safeWidth));
    lines.push(bottom);
    return lines;
  }
}

export function registerSkillsCommand(pi: ExtensionAPI, store: SkillStore): void {
  pi.registerCommand("memory-skills", {
    description: "Manage global and active-project procedural skills",
    handler: async (_args, ctx: ExtensionCommandContext) => {
      const skills = await store.loadIndex();
      const projectName = store.getProjectName();

      if (!ctx.hasUI || typeof ctx.ui.custom !== "function") {
        ctx.ui.notify(formatSkillsList(skills, projectName), "info");
        return;
      }

      const initialRows = buildSkillRows(skills);

      try {
        await ctx.ui.custom<void>(
          (tui, theme, _keybindings, done) => new SkillsManagerModal(
            tui,
            theme,
            initialRows,
            {
              moveSelected: (scope, skillIds) => moveSelectedSkills(store, skillIds, scope),
              deleteSelected: (skillIds) => deleteSelectedSkills(store, skillIds),
              close: () => done(undefined),
              projectName,
            },
          ),
          {
            overlay: true,
            overlayOptions: {
              anchor: "center",
              width: "88%",
              minWidth: 72,
              maxHeight: "85%",
              margin: 1,
            },
          },
        );
      } catch {
        const latestSkills = await store.loadIndex();
        ctx.ui.notify(
          "Interactive skills manager unavailable in this runtime; showing read-only list fallback.",
          "warning",
        );
        ctx.ui.notify(formatSkillsList(latestSkills, projectName), "info");
      }
    },
  });
}
