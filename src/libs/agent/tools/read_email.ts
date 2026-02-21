import { tool } from "ai";
import { z } from "zod";
import { executeEmailAction } from "./email_base";
import { canReadEmail } from "./permissions";

export const readEmailTool = (context: any) =>
  tool({
    description:
      "Read latest emails via IMAP (Gmail/iCloud/Outlook/custom supported).",
    inputSchema: z.object({
      provider: z.enum(["gmail", "icloud", "outlook", "custom"]).default("gmail"),
      authMode: z.enum(["password", "oauth2"]).default("password"),
      username: z.string().email().describe("邮箱账号"),
      password: z.string().optional().describe("邮箱密码或应用专用密码（iCloud 推荐 app-specific password）"),
      accessToken: z.string().optional().describe("OAuth2 access token"),
      imapHost: z.string().optional().describe("IMAP 主机，custom 模式必填；iCloud/Outlook可省略用默认"),
      imapPort: z.number().int().positive().optional().describe("IMAP 端口，默认 993"),
      folder: z.string().default("INBOX").describe("读取文件夹"),
      limit: z.number().int().min(1).max(50).default(5).describe("读取最新邮件数量"),
      unseenOnly: z.boolean().default(false).describe("只读取未读邮件"),
      includeBody: z.boolean().default(true).describe("是否包含纯文本正文"),
    }),
    execute: async (input) => {
      const targetHost = input.provider === "gmail"
        ? "imap.gmail.com"
        : input.provider === "icloud"
        ? "imap.mail.me.com"
        : input.provider === "outlook"
        ? "outlook.office365.com"
        : (input.imapHost ?? "");

      if (!canReadEmail(targetHost, context?.permissions?.tools)) {
        return {
          error: "Permission denied: read_email host not allowed",
        };
      }

      return executeEmailAction("read", input);
    },
  });
