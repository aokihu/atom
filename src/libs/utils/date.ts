/**
 * 日期时间相关的辅助方法
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 1.0
 */

/**
 * 返回格式化的当前日期和时间字符串
 * @returns {string} 格式化后的日期和时间
 */
export const formatedDatetimeNow = () => new Date().toISOString();
