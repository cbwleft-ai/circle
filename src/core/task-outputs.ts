/**
 * 任务产出物只读访问 —— 供 Coordinator 核对 Worker 完整输出与归档文件。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, normalize, relative } from "node:path";
import { summarizeText } from "./summarize.js";
import type { TaskStore } from "./task-store.js";
import type { WorkspaceManager } from "./workspace.js";

/** 单次读取文件大小上限（512KB）；超出时采用头尾摘要 */
export const TASK_OUTPUT_MAX_READ_BYTES = 512 * 1024;

const SKIP_DIRS = new Set([".pi"]);

interface OutputEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

function resolveSafePath(root: string, filePath: string): string | { error: string } {
  const trimmed = filePath.trim();
  if (!trimmed) return { error: "请指定文件相对路径" };
  const normalized = normalize(trimmed.replace(/^[/\\]+/, ""));
  if (normalized.startsWith("..") || normalized.includes("\0")) {
    return { error: "非法路径：不允许使用 .. 或绝对路径" };
  }
  const full = join(root, normalized);
  const rel = relative(root, full);
  if (rel.startsWith("..") || rel.includes("\0")) {
    return { error: "路径超出任务产出目录范围" };
  }
  return full;
}

function collectFiles(dir: string, prefix = ""): OutputEntry[] {
  const entries: OutputEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!prefix && SKIP_DIRS.has(name)) continue;
    const rel = prefix ? join(prefix, name) : name;
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      entries.push(...collectFiles(full, rel));
    } else if (st.isFile()) {
      entries.push({ path: rel.replace(/\\/g, "/"), size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN");
}

/** 列出任务产出物目录中的文件（只读） */
export function listTaskOutputs(
  workspace: WorkspaceManager,
  taskStore: TaskStore,
  taskId: string,
): string {
  const task = taskStore.get(taskId);
  if (!task) return `未找到任务 ${taskId}。`;

  const root = workspace.taskOutputDir(task.workerName, taskId);
  if (!root) {
    return `任务 ${taskId} 尚无产出物目录（可能尚未开始执行或工作空间已被清理）。`;
  }

  const files = collectFiles(root);
  if (files.length === 0) {
    return `任务 ${taskId} 产出物目录：${root}\n（目录为空）`;
  }

  const lines = files.map(
    (f) => `- ${f.path} (${formatSize(f.size)}, 修改于 ${formatTime(f.mtimeMs)})`,
  );
  return `任务 ${taskId} 产出物目录：${root}\n共 ${files.length} 个文件：\n${lines.join("\n")}`;
}

/** 读取任务产出物目录中的指定文件（只读） */
export function readTaskOutput(
  workspace: WorkspaceManager,
  taskStore: TaskStore,
  taskId: string,
  filePath: string,
): string {
  const task = taskStore.get(taskId);
  if (!task) return `未找到任务 ${taskId}。`;

  const root = workspace.taskOutputDir(task.workerName, taskId);
  if (!root) {
    return `任务 ${taskId} 尚无产出物目录（可能尚未开始执行或工作空间已被清理）。`;
  }

  const resolved = resolveSafePath(root, filePath);
  if (typeof resolved !== "string") return resolved.error;

  if (!existsSync(resolved)) {
    return `文件不存在：${filePath}（任务 ${taskId}，目录 ${root}）`;
  }

  const st = statSync(resolved);
  if (!st.isFile()) {
    return `「${filePath}」不是文件，请使用 list_task_outputs 查看可读文件列表。`;
  }

  if (st.size > TASK_OUTPUT_MAX_READ_BYTES) {
    const buf = readFileSync(resolved);
    const text = buf.toString("utf-8");
    const preview = summarizeText(text, { maxChars: 8000, headChars: 3500, tailChars: 3500 });
    return `任务 ${taskId} / ${filePath} (${formatSize(st.size)}，超出单次读取上限 ${formatSize(TASK_OUTPUT_MAX_READ_BYTES)}，以下为摘要)：\n\n${preview}`;
  }

  const buf = readFileSync(resolved);
  if (buf.includes(0)) {
    return `任务 ${taskId} / ${filePath} (${formatSize(st.size)})：二进制文件，无法以文本形式读取。`;
  }

  const content = buf.toString("utf-8");
  return `任务 ${taskId} / ${filePath} (${formatSize(st.size)})：\n\n${content}`;
}
