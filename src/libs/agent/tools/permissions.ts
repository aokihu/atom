/**
 * 权限检查模块
 *
 * 提供基于正则表达式的权限检查功能，包含内置安全规则和用户配置规则。
 * 内置安全规则提供基础防护，防止常见攻击向量如路径遍历、命令注入等。
 *
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 1.1
 * @description 权限检查和安全防护
 */

import { isAbsolute, relative, resolve } from "node:path";
import type {
  AgentPermissionRules,
  AgentToolsPermission,
} from "../../../types/agent";

/**
 * 内置安全规则 - 防止常见攻击向量
 *
 * 这些规则在所有配置规则之前执行，提供基础安全防护。
 * 即使配置文件错误或遗漏，这些规则也能防止常见攻击。
 *
 * 规则说明：
 * 1. 路径遍历攻击防护 - 防止通过../或..\访问上级目录
 * 2. URL编码绕过防护 - 防止通过URL编码绕过路径检查
 * 3. 空字节注入防护 - 防止通过空字节截断文件路径
 * 4. UNC路径防护 - 防止访问Windows网络共享
 * 5. Shell命令注入防护 - 防止在路径中注入shell命令
 * 6. 环境变量扩展防护 - 防止通过${ENV_VAR}扩展环境变量
 * 7. Unix系统目录防护 - 防止访问关键系统目录
 * 8. Windows系统目录防护 - 防止访问Windows系统目录
 * 9. 本地URL协议防护 - 防止通过webfetch访问本地协议
 *
 * @constant {RegExp[]}
 */
const BUILTIN_DENY_PATTERNS = [
  // 1. 路径遍历攻击 (基本防护) - 匹配../, ..\, ..结尾
  /\.\.(?:[\/\\]|$)/,

  // 2. URL编码的路径遍历绕过 - 匹配URL编码的路径遍历
  /\.\.%2f/i, // ../ URL编码
  /\.\.%5c/i, // ..\ URL编码
  /\.\.%252f/i, // ../ 双重URL编码
  /\.\.%255c/i, // ..\ 双重URL编码

  // 3. 空字节注入攻击 (常用于文件路径截断) - 匹配空字节
  /%00/, // URL编码的空字节
  /\x00/, // 字面量空字节

  // 4. Windows UNC路径 (网络共享访问) - 匹配\\server\share格式
  /^\\\\/, // \\server\share 格式

  // 5. Shell命令注入字符 - 匹配常见shell元字符
  /[;&|`\$\(\)]/, // 常见的shell元字符

  // 6. 环境变量扩展 - 匹配${ENV_VAR}格式
  /\$\{[^}]+\}/, // ${ENV_VAR} 格式

  // 7. Unix系统目录 (绝对路径) - 匹配关键系统目录
  /^\/(?:etc|var|usr|bin|sbin|dev|proc|sys|boot|lib|root)(?:\/|$)/,

  // 8. Windows系统目录 - 匹配Windows系统目录
  /^[A-Za-z]:\\(?:Windows|Program Files|ProgramData|System32|Users\\[^\\]+\\AppData)(?:\\|$)/i,

  // 9. 本地URL协议限制 (防止通过webfetch访问本地文件) - 匹配本地协议
  /^(?:file|ftp|ssh|telnet|gopher|sftp):\/\//i,
];

/**
 * 检查目标字符串是否违反内置安全规则
 *
 * 此函数执行多层安全检查：
 * 1. 首先检查所有内置拒绝模式
 * 2. 然后尝试解码URL编码的字符串，检查解码后是否包含路径遍历
 * 3. 返回是否违反任何安全规则
 *
 * @param {string} target - 要检查的目标字符串（文件路径、URL、主机名等）
 * @returns {boolean} true表示违反安全规则，false表示安全
 *
 * @example
 * violatesBuiltinRules('../etc/passwd') // true - 路径遍历
 * violatesBuiltinRules('..%2fetc%2fpasswd') // true - URL编码绕过
 * violatesBuiltinRules('/home/user/file.txt') // false - 安全路径
 */
const violatesBuiltinRules = (target: string): boolean => {
  // 第一层：检查所有内置拒绝模式
  for (const pattern of BUILTIN_DENY_PATTERNS) {
    if (pattern.test(target)) {
      return true;
    }
  }

  // 第二层：尝试解码URL编码的路径后再次检查路径遍历
  // 防止通过多重编码绕过基础检查
  try {
    const decoded = decodeURIComponent(target);
    if (/\.\.(?:[\/\\]|$)/.test(decoded)) {
      return true;
    }
  } catch {
    // 解码失败，忽略 - 这不是有效的URL编码字符串
  }

  return false;
};

const normalizeWorkspacePath = (workspace?: string) => {
  const normalized = typeof workspace === "string" ? workspace.trim() : "";
  return normalized ? resolve(normalized) : null;
};

const isPathEqualOrDescendant = (target: string, base: string) => {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const escapeRegexText = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const normalizePathSeparators = (value: string) =>
  value.replaceAll("\\", "/");

const SENSITIVE_ROOT_DIR_NAMES = new Set(["secrets"]);
const SENSITIVE_ROOT_FILE_NAMES = new Set(["agent.config.json"]);

const toWorkspaceRelativePath = (targetPath: string, workspace?: string) => {
  const workspacePath = normalizeWorkspacePath(workspace);
  if (!workspacePath) {
    return null;
  }

  const target = resolve(targetPath);
  if (!isPathEqualOrDescendant(target, workspacePath)) {
    return null;
  }

  const rel = relative(workspacePath, target).replaceAll("\\", "/");
  return rel;
};

const isWorkspaceSensitivePathHardBlocked = (
  targetPath: string,
  workspace?: string,
) => {
  const rel = toWorkspaceRelativePath(targetPath, workspace);
  if (rel === null || rel === "") {
    return false;
  }

  const parts = rel.split("/");
  if (parts.length === 0) {
    return false;
  }
  const first = parts[0] ?? "";
  const leaf = parts[parts.length - 1] ?? "";

  if (SENSITIVE_ROOT_DIR_NAMES.has(first)) {
    return true;
  }
  if (parts.length === 1 && SENSITIVE_ROOT_FILE_NAMES.has(first)) {
    return true;
  }
  if (leaf.startsWith(".env")) {
    return true;
  }

  return false;
};

type SensitivePathReferenceOptions = {
  workspace?: string;
  cwd?: string;
};

export const hasSensitiveWorkspacePathReference = (
  input: string,
  options: SensitivePathReferenceOptions,
) => {
  const workspacePath = normalizeWorkspacePath(options.workspace);
  if (!workspacePath) {
    return false;
  }

  const text = normalizePathSeparators(input ?? "");
  if (text.trim() === "") {
    return false;
  }

  const workspaceNormalized = normalizePathSeparators(workspacePath);
  const workspaceRegexText = escapeRegexText(workspaceNormalized);
  const absolutePatterns = [
    new RegExp(`${workspaceRegexText}/\\.agent(?:/|\\b)`),
    new RegExp(`${workspaceRegexText}/secrets(?:/|\\b)`),
    new RegExp(`${workspaceRegexText}/agent\\.config\\.json(?:\\b|$)`),
    new RegExp(`${workspaceRegexText}/\\.env(?:\\.[A-Za-z0-9._-]+)?(?:\\b|$)`),
  ];

  if (absolutePatterns.some((pattern) => pattern.test(text))) {
    return true;
  }

  const cwd = options.cwd;
  if (!cwd) {
    return false;
  }

  const cwdPath = resolve(cwd);
  if (!isPathEqualOrDescendant(cwdPath, workspacePath)) {
    return false;
  }

  const relativePatterns = [
    /(^|[\s"'`:])(?:\.\/)?\.agent(?:\/|\b)/,
    /(^|[\s"'`:])(?:\.\/)?secrets(?:\/|\b)/,
    /(^|[\s"'`:])(?:\.\/)?agent\.config\.json(?:\b|$)/,
    /(^|[\s"'`:])(?:\.\/)?\.env(?:\.[A-Za-z0-9._-]+)?(?:\b|$)/,
    /(^|[\s"'`:])(?:\.\.\/)+(?:\.agent(?:\/|\b)|secrets(?:\/|\b)|agent\.config\.json(?:\b|$)|\.env(?:\.[A-Za-z0-9._-]+)?(?:\b|$))/,
  ];

  return relativePatterns.some((pattern) => pattern.test(text));
};

export const isWorkspaceAgentHardBlocked = (
  targetPath: string,
  workspace?: string,
) => {
  const workspacePath = normalizeWorkspacePath(workspace);
  if (!workspacePath) {
    return false;
  }

  const protectedDir = resolve(workspacePath, ".agent");
  const target = resolve(targetPath);
  return isPathEqualOrDescendant(target, protectedDir);
};

const isWorkspaceHardBlockedPath = (
  targetPath: string,
  workspace?: string,
) =>
  isWorkspaceAgentHardBlocked(targetPath, workspace) ||
  isWorkspaceSensitivePathHardBlocked(targetPath, workspace);

export const shouldHideWorkspaceAgentEntry = (
  parentDir: string,
  entryName: string,
  workspace?: string,
) => {
  return isWorkspaceHardBlockedPath(resolve(parentDir, entryName), workspace);
};

export const getWorkspaceAgentRipgrepExcludes = (
  searchDir: string,
  workspace?: string,
) => {
  const workspacePath = normalizeWorkspacePath(workspace);
  if (!workspacePath) {
    return [] as string[];
  }

  const normalizedSearchDir = resolve(searchDir);
  if (!isPathEqualOrDescendant(normalizedSearchDir, workspacePath)) {
    return [] as string[];
  }

  const excludes: string[] = [];
  const addExclude = (value: string) => {
    if (!excludes.includes(value)) {
      excludes.push(value);
    }
  };
  const addPathExcludes = (targetPath: string, recursive: boolean) => {
    if (!isPathEqualOrDescendant(targetPath, normalizedSearchDir)) {
      return;
    }

    const rel = relative(normalizedSearchDir, targetPath);
    if (rel === "") {
      return;
    }

    const normalizedRel = rel.replaceAll("\\", "/");
    addExclude(`!${normalizedRel}`);
    if (recursive) {
      addExclude(`!${normalizedRel}/**`);
    }
  };

  addPathExcludes(resolve(workspacePath, ".agent"), true);
  addPathExcludes(resolve(workspacePath, "secrets"), true);
  addPathExcludes(resolve(workspacePath, "agent.config.json"), false);

  addExclude("!.env*");
  addExclude("!**/.env*");
  addExclude("!.env*/**");
  addExclude("!**/.env*/**");

  return excludes;
};

/**
 * 根据规则检查目标字符串是否被允许
 *
 * 检查顺序（优先级从高到低）：
 * 1. 内置安全规则 - 最高优先级，不可绕过
 * 2. 用户配置的deny规则 - 用户定义的拒绝规则
 * 3. 用户配置的allow规则 - 用户定义的允许规则
 *
 * 规则说明：
 * - 如果违反内置安全规则，立即拒绝
 * - 如果没有提供规则，默认允许
 * - 如果匹配任何deny规则，拒绝
 * - 如果没有allow规则，允许
 * - 如果匹配任何allow规则，允许
 * - 否则拒绝
 *
 * @param {string} target - 要检查的目标字符串
 * @param {AgentPermissionRules} [rules] - 用户配置的权限规则
 * @returns {boolean} true表示允许访问，false表示拒绝访问
 *
 * @example
 * // 内置规则阻止
 * matchByRules('../etc/passwd', { allow: ['.*'] }) // false
 *
 * // 用户deny规则阻止
 * matchByRules('/tmp/file.txt', { deny: ['^/tmp/'] }) // false
 *
 * // 用户allow规则允许
 * matchByRules('/home/user/file.txt', { allow: ['^/home/'] }) // true
 */
const matchByRules = (target: string, rules?: AgentPermissionRules) => {
  // 第一步：检查内置安全规则（最高优先级）
  if (violatesBuiltinRules(target)) {
    return false;
  }

  // 第二步：如果没有规则，默认允许
  if (!rules) {
    return true;
  }

  // 第三步：检查用户配置的deny规则
  const denyPatterns = (rules.deny ?? []).map((item) => new RegExp(item));
  if (denyPatterns.some((regex) => regex.test(target))) {
    return false;
  }

  // 第四步：检查用户配置的allow规则
  const allowPatterns = (rules.allow ?? []).map((item) => new RegExp(item));
  if (allowPatterns.length === 0) {
    return true;
  }

  return allowPatterns.some((regex) => regex.test(target));
};

/**
 * 检查是否允许读取文件
 *
 * @param {string} filepath - 文件路径
 * @param {AgentToolsPermission} [tools] - 工具配置
 * @returns {boolean} 是否允许读取
 */
export const canReadFile = (
  filepath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(filepath, workspace)) {
    return false;
  }

  return matchByRules(filepath, tools?.read);
};

/**
 * 检查是否允许列出目录内容
 *
 * @param {string} dirpath - 目录路径
 * @param {AgentToolsPermission} [tools] - 工具配置
 * @returns {boolean} 是否允许列出目录
 */
export const canListDir = (
  dirpath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(dirpath, workspace)) {
    return false;
  }

  return matchByRules(dirpath, tools?.ls);
};

/**
 * 检查是否允许读取目录树
 *
 * @param {string} dirpath - 目录路径
 * @param {AgentToolsPermission} [tools] - 工具配置
 * @returns {boolean} 是否允许读取目录树
 */
export const canReadTree = (
  dirpath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(dirpath, workspace)) {
    return false;
  }

  return matchByRules(dirpath, tools?.tree);
};

/**
 * 检查是否允许使用ripgrep搜索目录
 *
 * @param {string} dirpath - 目录路径
 * @param {AgentToolsPermission} [tools] - 工具配置
 * @returns {boolean} 是否允许使用ripgrep
 */
export const canRipgrep = (
  dirpath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(dirpath, workspace)) {
    return false;
  }

  return matchByRules(dirpath, tools?.ripgrep);
};

/**
 * 检查是否允许写入文件
 *
 * @param {string} filepath - 文件路径
 * @param {AgentToolsPermission} [tools] - 工具配置
 * @returns {boolean} 是否允许写入
 */
export const canWriteFile = (
  filepath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(filepath, workspace)) {
    return false;
  }

  return matchByRules(filepath, tools?.write);
};

/**
 * 检查是否允许使用 TODO 数据库文件
 */
export const canUseTodo = (filepath: string, tools?: AgentToolsPermission) =>
  matchByRules(filepath, tools?.todo);

/**
 * 检查是否允许使用 memory 工具（持久化记忆库）
 */
export const canUseMemory = (target: string, tools?: AgentToolsPermission) =>
  matchByRules(target, tools?.memory);

/**
 * 检查是否允许从源路径复制
 */
export const canCopyFrom = (
  filepath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(filepath, workspace)) {
    return false;
  }

  return matchByRules(filepath, tools?.cp);
};

/**
 * 检查是否允许复制到目标路径
 */
export const canCopyTo = (
  filepath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(filepath, workspace)) {
    return false;
  }

  return matchByRules(filepath, tools?.cp);
};

/**
 * 检查是否允许从源路径移动
 */
export const canMoveFrom = (
  filepath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(filepath, workspace)) {
    return false;
  }

  return matchByRules(filepath, tools?.mv);
};

/**
 * 检查是否允许移动到目标路径
 */
export const canMoveTo = (
  filepath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(filepath, workspace)) {
    return false;
  }

  return matchByRules(filepath, tools?.mv);
};

/**
 * 检查是否允许在指定目录执行 git
 */
export const canUseGit = (
  dirpath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(dirpath, workspace)) {
    return false;
  }

  return matchByRules(dirpath, tools?.git);
};

/**
 * 检查是否允许在指定目录执行 bash
 */
export const canUseBash = (
  dirpath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(dirpath, workspace)) {
    return false;
  }

  return matchByRules(dirpath, tools?.bash);
};

/**
 * 检查是否允许在指定目录执行 background(tmux) 操作
 */
export const canUseBackground = (
  dirpath: string,
  tools?: AgentToolsPermission,
  workspace?: string,
) => {
  if (isWorkspaceHardBlockedPath(dirpath, workspace)) {
    return false;
  }

  return matchByRules(dirpath, tools?.background);
};

/**
 * 检查是否允许访问URL
 *
 * @param {string} url - URL地址
 * @param {AgentToolsPermission} [tools] - 工具配置
 * @returns {boolean} 是否允许访问
 */
export const canVisitUrl = (url: string, tools?: AgentToolsPermission) =>
  matchByRules(url, tools?.webfetch);
