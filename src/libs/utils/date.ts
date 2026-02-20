/**
 * 日期时间相关的辅助方法
 * @author aokihu <aokihu@gmail.com>
 * @license BSD
 * @version 1.0
 */

const formatter = new Intl.DateTimeFormat("UTC", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false, // 使用24小时制
  timeZone: "Asia/Shanghai",
  timeZoneName: "shortOffset",
});

/**
 * 返回格式化的当前日期和时间字符串
 * @returns {string} 格式化后的日期和时间
 */
export const formatedDatetimeNow = () => formatter.format(new Date());
