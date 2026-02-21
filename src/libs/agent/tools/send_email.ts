import { tool } from "ai";
import { z } from "zod";
import { executeEmailAction } from "./email_base";
import { canSendEmail } from "./permissions";

export const sendEmailTool = (context: any) =>
  tool({
    description:
      "Send emails via SMTP (Gmail/iCloud/Outlook/custom supported).",
    inputSchema: z.object({
      provider: z.enum(["gmail", "icloud", "outlook", "custom"]).default("gmail"),
      authMode: z.enum(["password", "oauth2"]).default("password"),
      username: z.string().email().describe("发件邮箱账号"),
      password: z.string().optional().describe("邮箱密码或应用专用密码（iCloud 推荐 app-specific password）"),
      accessToken: z.string().optional().describe("OAuth2 access token"),
      smtpHost: z.string().optional().describe("SMTP 主机，custom 模式必填；iCloud/Outlook可省略用默认"),
      smtpPort: z.number().int().positive().optional().describe("SMTP 端口，默认 465"),
      useTls: z.boolean().default(true).describe("是否使用 TLS"),
      fromName: z.string().optional().describe("发件人显示名称"),
      to: z.array(z.string().email()).min(1).describe("收件人"),
      cc: z.array(z.string().email()).optional().default([]).describe("抄送"),
      bcc: z.array(z.string().email()).optional().default([]).describe("密送"),
      subject: z.string().default(""),
      text: z.string().default(""),
      html: z.string().optional().describe("HTML 正文"),
    }),
    execute: async (input) => {
      const targetHost = input.provider === "gmail"
        ? "smtp.gmail.com"
        : input.provider === "icloud"
        ? "smtp.mail.me.com"
        : input.provider === "outlook"
        ? "smtp.office365.com"
        : (input.smtpHost ?? "");

      if (!canSendEmail(targetHost, context?.permissions?.tools)) {
        return {
          error: "Permission denied: send_email host not allowed",
        };
      }

      return executeEmailAction("send", input);
    },
  });
