/**
 * 工作目录环境检查
 * @author aokihu <aokihu@gmail.com>
 * @license BSD-3-Clause
 * @version 1.0
 * @description 检查工作目录环境
 *              - 检查工作目录中是否有"AGENT.md"文件
 *              - 检查工作目录中是否有"agent.config.json"文件
 *              - 检查工作目录中是否有".memory"目录
 *
 *              如果不存在这些文件或者目录,则自动创建它们或者复制模版到工作目录
 */

import { resolve } from "node:path";
import { constants } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";

/* 内置模版文件 */
import AgentMdFile from "../../templates/AGENT.md" with { type: "file" };
import AgentConfigJsonFile from "../../templates/agent.config.json" with { type: "file" };

/**
 * 检查工作目录环境
 * @param workspace 当前工作的目录
 */
export const workspace_check = async (workspace: string) => {
  const agentFilePath = resolve(workspace, "AGENT.md");
  const agentConfigJsonFilePath = resolve(workspace, "agent.config.json");
  const memoryFolderPath = resolve(workspace, "memory");
  const secretsFolderPath = resolve(workspace, "secrets");

  await Promise.all([
    ensureTemplateFile(AgentMdFile, agentFilePath),
    ensureTemplateFile(AgentConfigJsonFile as unknown as string, agentConfigJsonFilePath),
    mkdir(memoryFolderPath, { recursive: true }),
    mkdir(secretsFolderPath, { recursive: true }),
  ]);
};

const ensureTemplateFile = async (sourcePath: string, targetPath: string) => {
  try {
    await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if (!isEexistError(error)) {
      throw error;
    }
  }
};

const isEexistError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as NodeJS.ErrnoException).code === "EEXIST";
