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
import { copyFile, mkdir, exists } from "node:fs/promises";

/* 内置模版文件 */
import AgentMdFile from "../../templates/AGENT.md" with { type: "file" };
import AgentConfigJsonFile from "../../templates/agent.config.json" with { type: "file" };

/**
 * 检查工作目录环境
 * @param workspace 当前工作的目录
 */
export const workspace_check = async (workspace: string) => {
  await checkAgentFile(workspace);
  await checkAgentConfigJsonFile(workspace);
  await checkMemoryFolder(workspace);
  await checkSecretsFolder(workspace);
};

const checkAgentFile = async (workspace: string) => {
  const agentFilePath = resolve(workspace, "AGENT.md");
  const agentFileExists = await Bun.file(agentFilePath).exists();
  if (!agentFileExists) {
    await copyFile(AgentMdFile, agentFilePath);
  }
};

const checkAgentConfigJsonFile = async (workspace: string) => {
  const agentConfigJsonFilePath = resolve(workspace, "agent.config.json");
  const agentConfigJsonFileExists = await Bun.file(
    agentConfigJsonFilePath,
  ).exists();
  if (!agentConfigJsonFileExists) {
    // @ts-ignore
    await copyFile(AgentConfigJsonFile, agentConfigJsonFilePath);
  }
};   

const checkMemoryFolder = async (workspace: string) => {
  const memoryFolderPath = resolve(workspace, "memory");
  const memoryFolderExists = await exists(memoryFolderPath);
  if (!memoryFolderExists) {
    await mkdir(memoryFolderPath);
  }
};

const checkSecretsFolder = async (workspace: string) => {
  const secretsFolderPath = resolve(workspace, "secrets");
  const secretsFolderExists = await exists(secretsFolderPath);
  if (!secretsFolderExists) {
    await mkdir(secretsFolderPath);
  }
};
