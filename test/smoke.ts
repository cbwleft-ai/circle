/**
 * 快速冒烟测试：验证 pi SDK + DeepSeek 会话与 Coordinator 工具可用性。
 * 用法: npx tsx test/smoke.ts
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CoordinatorAgent } from "../src/agents/coordinator.js";
import { loadConfig } from "../src/config.js";
import type { DispatchResult, ScheduledTask, WorkerConfig } from "../src/core/types.js";

async function main() {
  const config = loadConfig();
  console.log("ModelRuntime 创建…");
  const rt = await ModelRuntime.create();
  const model = rt.getModel(config.modelProvider, config.modelId);
  console.log(`模型: ${model?.provider}/${model?.id} (${model?.name})`);

  // 最小 gateway 桩
  const gateway = {
    listWorkers: (): WorkerConfig[] => [
      { name: "dev", description: "开发 Worker", cwd: "/tmp/circle-smoke/dev" },
    ],
    dispatch: async (): Promise<DispatchResult> => ({
      ok: true,
      async: false,
      task: {
        id: "T-SMOKE-0001",
        title: "x",
        description: "x",
        status: "completed",
        priority: "short",
        workerName: "dev",
        requestedBy: "user",
        createdAt: Date.now(),
      },
      message: "任务已收到。任务编号 T-SMOKE-0001 已派发。",
    }),
    createSchedule: (): ScheduledTask => ({
      id: "S-1",
      name: "x",
      cron: "0 10 * * *",
      description: "x",
      workerName: "dev",
      enabled: true,
      createdAt: Date.now(),
      taskIds: [],
    }),
    updateSchedule: () => undefined,
    deleteSchedule: () => undefined,
    listTasks: () => "暂无任务",
    listSchedules: () => "暂无定时任务",
    listArtifacts: () => "暂无产出物",
    readArtifact: () => "无",
    getTaskResult: () => undefined,
  };

  console.log("Coordinator 启动…");
  const coordinator = new CoordinatorAgent(rt, config, gateway);
  await coordinator.start();

  console.log("对话 1: 普通问候");
  const r1 = await coordinator.respond("你好，请用一句话介绍你自己");
  console.log(`>>> ${r1}`);

  console.log("\n对话 2: 派发任务（应调用 dispatch 工具）");
  const r2 = await coordinator.respond("派一个短程任务给 dev Worker：创建一个 hello.txt 写入 'hi'");
  console.log(`>>> ${r2}`);

  console.log("\n对话 3: 创建定时任务");
  const r3 = await coordinator.respond("创建一个定时任务，每天上午 9 点执行备份，cron 为 0 9 * * *");
  console.log(`>>> ${r3}`);

  await coordinator.dispose();
  console.log("\n冒烟测试完成 ✅");
}

main().catch((e) => {
  console.error("冒烟测试失败:", e);
  process.exit(1);
});
