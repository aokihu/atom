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

import type {
  AgentPermissionRules,
  AgentToolsConfig,
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
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许读取
 */
export const canReadFile = (filepath: string, tools?: AgentToolsConfig) =>
  matchByRules(filepath, tools?.read);

/**
 * 检查是否允许列出目录内容
 *
 * @param {string} dirpath - 目录路径
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许列出目录
 */
export const canListDir = (dirpath: string, tools?: AgentToolsConfig) =>
  matchByRules(dirpath, tools?.ls);

/**
 * 检查是否允许读取目录树
 *
 * @param {string} dirpath - 目录路径
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许读取目录树
 */
export const canReadTree = (dirpath: string, tools?: AgentToolsConfig) =>
  matchByRules(dirpath, tools?.tree);

/**
 * 检查是否允许使用ripgrep搜索目录
 *
 * @param {string} dirpath - 目录路径
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许使用ripgrep
 */
export const canRipgrep = (dirpath: string, tools?: AgentToolsConfig) =>
  matchByRules(dirpath, tools?.ripgrep);

/**
 * 检查是否允许写入文件
 *
 * @param {string} filepath - 文件路径
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许写入
 */
export const canWriteFile = (filepath: string, tools?: AgentToolsConfig) =>
  matchByRules(filepath, tools?.write);

/**
 * 检查是否允许访问URL
 *
 * @param {string} url - URL地址
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许访问
 */
export const canVisitUrl = (url: string, tools?: AgentToolsConfig) =>
  matchByRules(url, tools?.webfetch);

/**
 * 检查是否允许读取邮件
 *
 * @param {string} host - 邮件服务器主机名
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许读取邮件
 */
export const canReadEmail = (host: string, tools?: AgentToolsConfig) =>
  matchByRules(host, tools?.read_email);

/**
 * 检查是否允许发送邮件
 *
 * @param {string} host - 邮件服务器主机名
 * @param {AgentToolsConfig} [tools] - 工具配置
 * @returns {boolean} 是否允许发送邮件
 */
export const canSendEmail = (host: string, tools?: AgentToolsConfig) =>
  matchByRules(host, tools?.send_email);
