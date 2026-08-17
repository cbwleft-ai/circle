/**
 * 工作空间管理
 *
 * - 每个 Worker 拥有独立持久目录：data/workspaces/<workerName>/
 *   技能（.pi/skills/）存放于此；不再作为任务执行目录。
 * - 每个任务拥有**专属会话工作空间**：data/workspaces/<workerName>/tasks/<taskId>/
 *   Worker 会话的 cwd 指向该目录，任务之间完全隔离（互不可见、互不影响）。
 * - 任务完成后，其工作空间被**归档**为产出物目录：
 *   data/workspaces/<workerName>/outputs/<taskId>/（持久保留，便于取用）。
 * - 任务工作空间在任务记录被清理（默认 30 天）时删除；产出物目录不自动清理。
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, sep, join } from "node:path";
import { summarizeText } from "./text.js";
import { log } from "./logger.js";

/** 单文件最多读取的字符数（超长时头尾保留，防止拖垮 Coordinator 上下文） */
export const MAX_ARTIFACT_READ_CHARS = 20_000;
/** 产出物清单最多返回条目数 */
export const MAX_ARTIFACT_LIST_ENTRIES = 500;

/** 产出物清单条目 */
export interface ArtifactEntry {
  /** 相对产出物根目录的路径（目录以 / 结尾） */
  path: string;
  /** 字节数（目录为 0） */
  size: number;
  /** 最后修改时间（ms） */
  mtime: number;
  type: "file" | "dir";
}

/** 产出物文件读取结果 */
export interface ReadArtifactResult {
  ok: boolean;
  /** 文件内容（超长时头尾保留 + 中间省略标记） */
  content?: string;
  /** 文件完整字节数 */
  size?: number;
  /** 内容是否被截断（仅返回部分） */
  truncated?: boolean;
  /** 失败原因（路径越界 / 二进制 / 不存在等） */
  error?: string;
}

export class WorkspaceManager {
  private readonly agentDir: string;

  constructor(
    private readonly root: string,
    /** pi 全局配置目录（~/.pi/agent），用于链接用户级技能 */
    agentDir?: string,
  ) {
    this.agentDir = agentDir ?? join(homedir(), ".pi", "agent");
    mkdirSync(root, { recursive: true });
  }

  /** Worker 持久目录（技能、配置；不再作为任务执行目录） */
  workerDir(workerName: string): string {
    const dir = join(this.root, workerName);
    mkdirSync(dir, { recursive: true });
    // 确保技能目录存在
    mkdirSync(join(dir, ".pi", "skills"), { recursive: true });
    return dir;
  }

  /**
   * 任务专属会话工作空间（会话 cwd 指向此处，任务间完全隔离）。
   * 创建时建立两个技能软链接，使技能在任务工作空间内即可访问：
   * - .pi/skills       → Worker 技能目录（项目级）
   * - .pi/agent-skills → 用户级技能目录（~/.pi/agent/skills）
   * 链接失败（如 Windows 权限）不影响任务执行。
   */
  taskWorkspaceDir(workerName: string, taskId: string): string {
    const dir = join(this.root, workerName, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    this.linkWorkerSkills(workerName, dir);
    this.linkAgentSkills(dir);
    return dir;
  }

  /** 在任务工作空间内创建 .pi/skills → <workerDir>/.pi/skills 软链接 */
  private linkWorkerSkills(workerName: string, taskWorkspace: string): void {
    const target = join(this.root, workerName, ".pi", "skills");
    const link = join(taskWorkspace, ".pi", "skills");
    if (!existsSync(target)) return;
    if (existsSync(link)) return;
    try {
      mkdirSync(join(taskWorkspace, ".pi"), { recursive: true });
      symlinkSync(target, link, "dir");
      log.info("workspace", `任务工作空间技能软链接: ${link} → ${target}`);
    } catch (e) {
      log.warn("workspace", `技能软链接创建失败（不影响任务执行）: ${(e as Error).message}`);
    }
  }

  /** 在任务工作空间内创建 .pi/agent-skills → <agentDir>/skills 软链接 */
  private linkAgentSkills(taskWorkspace: string): void {
    const target = join(this.agentDir, "skills");
    const link = join(taskWorkspace, ".pi", "agent-skills");
    if (!existsSync(target)) return;
    if (existsSync(link)) return;
    try {
      mkdirSync(join(taskWorkspace, ".pi"), { recursive: true });
      symlinkSync(target, link, "dir");
      log.info("workspace", `用户级技能软链接: ${link} → ${target}`);
    } catch (e) {
      log.warn("workspace", `用户级技能软链接创建失败（不影响任务执行）: ${(e as Error).message}`);
    }
  }

  /** Worker 产出物归档目录 */
  outputsDir(workerName: string): string {
    return join(this.root, workerName, "outputs");
  }

  /**
   * 任务完成后归档产出物：把任务工作空间 tasks/<taskId> 重命名为 outputs/<taskId>。
   * 返回归档后的目录路径。重命名失败时回退为复制 + 删除源目录。
   */
  archiveTaskOutput(workerName: string, taskId: string): string {
    const src = join(this.root, workerName, "tasks", taskId);
    const dstDir = this.outputsDir(workerName);
    mkdirSync(dstDir, { recursive: true });
    const dst = join(dstDir, taskId);
    if (!existsSync(src)) {
      mkdirSync(dst, { recursive: true });
      return dst;
    }
    try {
      renameSync(src, dst);
      log.info("workspace", `归档任务产出物: ${src} → ${dst}`);
    } catch {
      // 跨设备等极端情况：复制后删除源目录
      copyDir(src, dst);
      rmSync(src, { recursive: true, force: true });
      log.info("workspace", `归档任务产出物（复制）: ${src} → ${dst}`);
    }
    // 产出物目录只保留任务真实产出，移除技能软链接（指向 Worker 技能目录）
    rmSync(join(dst, ".pi"), { recursive: true, force: true });
    return dst;
  }

  /**
   * 任务产出物根目录解析（只读访问入口，issue #21）：
   * - 已完成任务 → outputs/<workerName>/<taskId>/（归档后持久保留）；
   * - 未归档（执行中 / 失败）→ tasks/<workerName>/<taskId>/（任务工作空间，保留便于排查）；
   * 两者都不存在时返回 undefined。
   */
  taskArtifactRoot(workerName: string, taskId: string): string | undefined {
    const outputs = join(this.root, workerName, "outputs", taskId);
    if (existsSync(outputs)) return outputs;
    const tasks = join(this.root, workerName, "tasks", taskId);
    if (existsSync(tasks)) return tasks;
    return undefined;
  }

  /**
   * 递归列出任务产出物目录内文件清单（相对路径 + 大小）。
   * 安全约束：不跟随符号链接（避免通过链接逃逸出产出物目录）。
   */
  listTaskArtifacts(workerName: string, taskId: string): ArtifactEntry[] {
    const root = this.taskArtifactRoot(workerName, taskId);
    if (!root) return [];
    const out: ArtifactEntry[] = [];
    const stack = [""];
    while (stack.length > 0 && out.length < MAX_ARTIFACT_LIST_ENTRIES) {
      const rel = stack.pop()!;
      let entries: string[] = [];
      try {
        entries = readdirSync(join(root, rel));
      } catch {
        continue; // 并发删除时忽略
      }
      for (const e of entries.sort()) {
        const childRel = rel ? `${rel}/${e}` : e;
        try {
          const st = lstatSync(join(root, childRel));
          if (st.isSymbolicLink()) {
            // 符号链接不跟随：按文件列出（链接可能指向目录外）
            out.push({ path: childRel, size: 0, mtime: st.mtimeMs, type: "file" });
          } else if (st.isDirectory()) {
            out.push({ path: `${childRel}/`, size: 0, mtime: st.mtimeMs, type: "dir" });
            stack.push(childRel);
          } else {
            out.push({ path: childRel, size: st.size, mtime: st.mtimeMs, type: "file" });
          }
        } catch {
          /* 并发删除时忽略 */
        }
      }
    }
    return out;
  }

  /**
   * 读取任务产出物目录内单个文件内容（只读，Coordinator 侧核对用）。
   * 安全约束：
   * - 仅允许产出物根目录内的相对路径（拒绝绝对路径 / ../ 目录穿越，符号链接不跟随）；
   * - 单文件最多读取 MAX_ARTIFACT_READ_CHARS 字符，超长保留头尾 + 省略标记；
   * - 二进制文件（含 NUL 字节）拒绝返回，避免污染 Coordinator 上下文。
   */
  readTaskArtifact(workerName: string, taskId: string, relPath: string): ReadArtifactResult {
    const root = this.taskArtifactRoot(workerName, taskId);
    if (!root) {
      return { ok: false, error: `任务 ${taskId} 的产出物目录不存在` };
    }
    // 拒绝绝对路径与目录穿越（\ 在 Linux 下是合法文件名字符，但统一按非法路径拒绝）
    if (!relPath || relPath.startsWith("/") || relPath.includes("\\") || relPath.includes("..")) {
      return { ok: false, error: "路径不合法：仅允许产出物目录内的相对路径" };
    }
    const abs = resolve(root, relPath);
    const rootReal = resolve(root);
    if (abs !== rootReal && !abs.startsWith(rootReal + sep)) {
      return { ok: false, error: "路径越界：仅允许产出物目录内的相对路径" };
    }
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return { ok: false, error: `文件不存在: ${relPath}` };
    }
    if (st.isSymbolicLink()) return { ok: false, error: `${relPath} 是符号链接，出于安全考虑不予读取` };
    if (st.isDirectory()) {
      return { ok: false, error: `${relPath} 是目录，请先通过 list_artifacts 查看文件清单` };
    }
    // 二进制检测：读取文件头 8KB 判断是否含 NUL 字节
    try {
      const fd = openSync(abs, "r");
      try {
        const probe = Buffer.alloc(8192);
        const n = readSync(fd, probe, 0, probe.length, 0);
        if (probe.subarray(0, n).includes(0)) {
          return { ok: false, error: `${relPath} 是二进制文件，无法读取文本内容（大小 ${st.size} 字节）` };
        }
      } finally {
        closeSync(fd);
      }
    } catch (e) {
      return { ok: false, error: `读取失败: ${(e as Error).message}` };
    }
    let content: string;
    try {
      content = readFileSync(abs, "utf-8");
    } catch (e) {
      return { ok: false, error: `读取失败: ${(e as Error).message}` };
    }
    const truncated = content.length > MAX_ARTIFACT_READ_CHARS;
    return {
      ok: true,
      size: st.size,
      truncated,
      // 超长时头尾保留（关键结论通常在尾部），完整文件始终在产出物目录
      content: truncated
        ? summarizeText(content, {
            maxChars: MAX_ARTIFACT_READ_CHARS,
            headChars: 8000,
            tailChars: 8000,
          })
        : content,
    };
  }

  /** 删除任务工作空间（随任务记录清理时调用） */
  removeTaskWorkspace(workerName: string, taskId: string): void {
    rmSync(join(this.root, workerName, "tasks", taskId), { recursive: true, force: true });
  }

  /**
   * 清理超过 retentionMs 未修改的任务工作空间（tasks/ 下）。
   * 返回清理数量。产出物目录（outputs/）不在此列，持久保留。
   */
  cleanupStaleTaskWorkspaces(retentionMs: number): number {
    let removed = 0;
    let workers: string[] = [];
    try {
      workers = readdirSync(this.root).filter((n) => !n.startsWith("."));
    } catch {
      return 0;
    }
    for (const worker of workers) {
      const tasksRoot = join(this.root, worker, "tasks");
      if (!existsSync(tasksRoot)) continue;
      for (const taskId of readdirSync(tasksRoot)) {
        const dir = join(tasksRoot, taskId);
        try {
          const mtime = statSync(dir).mtimeMs;
          if (Date.now() - mtime > retentionMs) {
            rmSync(dir, { recursive: true, force: true });
            removed++;
            log.info("workspace", `清理过期任务工作空间: ${dir}`);
          }
        } catch {
          /* 并发删除时忽略 */
        }
      }
    }
    return removed;
  }
}

/** 递归复制目录（归档回退用）；符号链接保持为链接，不跟随复制 */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (lstatSync(s).isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(s), d);
      } catch {
        /* 链接失败时跳过 */
      }
    } else if (statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}
