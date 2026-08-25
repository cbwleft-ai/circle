/**
 * 上行附件落盘与消息富化（多模态/图片输入，issue #3）
 *
 * 用户在 IM 中发送图片/文件时，IM 适配器把附件以 `ChatMessage.attachments`
 * 携带进来；`AttachmentStore` 负责把附件写入 `{dataDir}/uploads/{chatId}/`，
 * 并返回落盘记录。团队层再把本地路径以 `【图片】<path>` 标记注入消息文本，
 * 使 Coordinator 能感知图片的存在并转述；Worker 执行时按落盘路径读取图片，
 * 直接作为图片输入（ImageContent）传给模型，无需二次转述。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import type { ChatAttachment } from "./types.js";

/** 落盘后的附件记录 */
export interface SavedAttachment {
  kind: "image" | "file";
  /** 文件名（含扩展名） */
  name: string;
  mimeType?: string;
  /** 绝对路径 */
  localPath: string;
}

/** 附件落盘管理 */
export class AttachmentStore {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  /** 将一组对话附件写入磁盘，返回落盘记录（失败的附件被跳过） */
  save(chatId: string, attachments: ChatAttachment[]): SavedAttachment[] {
    const saved: SavedAttachment[] = [];
    attachments.forEach((a, i) => {
      try {
        if (a.localPath && existsSync(a.localPath)) {
          // 已由适配器/调用方落盘，直接引用
          saved.push({
            kind: a.kind,
            name: a.name ?? basenameSafe(a.localPath),
            mimeType: a.mimeType,
            localPath: a.localPath,
          });
          return;
        }
        if (!a.data) return; // 无数据也无本地路径，跳过
        const name = sanitizeName(a.name) ?? defaultName(a.kind, i);
        const dir = this.chatDir(chatId);
        const localPath = join(dir, `${stamp()}${name}`);
        writeFileSync(localPath, Buffer.from(a.data, "base64"));
        saved.push({
          kind: a.kind,
          name,
          mimeType: a.mimeType,
          localPath,
        });
      } catch (e) {
        log.warn("upload", `附件落盘失败（${a.kind}/${a.name ?? "unnamed"}）: ${(e as Error).message}`);
      }
    });
    return saved;
  }

  private chatDir(chatId: string): string {
    const dir = join(this.root, safeChatId(chatId));
    mkdirSync(dir, { recursive: true });
    return dir;
  }
}

/**
 * 把附件路径注入消息文本（纯函数，便于测试）。
 * 发送给 Coordinator 的文本会带 `【图片】<path>` 标记，使其能感知图片并转述任务。
 */
export function buildMessageWithAttachments(
  text: string,
  saved: SavedAttachment[],
): string {
  if (saved.length === 0) return text;
  const lines = saved.map((s) => {
    const tag = s.kind === "image" ? "【图片】" : "【文件】";
    return `${tag}${s.localPath}`;
  });
  const joined = lines.join("\n");
  const trimmed = (text ?? "").trim();
  if (!trimmed) {
    return `用户发送了以下附件，请处理（图片请描述内容 / 识别图中文字）：\n${joined}`;
  }
  return `${joined}\n用户消息：${trimmed}`;
}

/** 生成带时间戳的前缀，避免重名覆盖 */
function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-`;
}

function sanitizeName(name?: string): string | undefined {
  if (!name) return undefined;
  // 只保留安全字符，防止路径穿越
  const cleaned = name.replace(/[\\/:\0]/g, "_").trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : undefined;
}

function defaultName(kind: "image" | "file", index: number): string {
  return kind === "image" ? `image-${index}.img` : `file-${index}.bin`;
}

function safeChatId(chatId: string): string {
  return chatId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "anon";
}

function basenameSafe(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}
