import { simpleParser } from "mailparser";
import { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";

type EmailAction = "read" | "send";
type Provider = "gmail" | "icloud" | "outlook" | "custom";
type AuthMode = "password" | "oauth2";

type ReadPayload = {
  provider?: Provider;
  authMode?: AuthMode;
  username?: string;
  password?: string;
  accessToken?: string;
  imapHost?: string;
  imapPort?: number;
  folder?: string;
  limit?: number;
  unseenOnly?: boolean;
  includeBody?: boolean;
};

type SendPayload = {
  provider?: Provider;
  authMode?: AuthMode;
  username?: string;
  password?: string;
  accessToken?: string;
  smtpHost?: string;
  smtpPort?: number;
  useTls?: boolean;
  fromName?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text?: string;
  html?: string;
};

const providerDefaults = {
  gmail: {
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 465,
  },
  icloud: {
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
  },
  outlook: {
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
  },
} as const;

const gmailAuthHint =
  "Gmail 建议优先 OAuth2；如使用密码登录，需开启两步验证并使用 app password。";

const mailboxHint = (provider: Provider) => {
  if (provider === "gmail") return gmailAuthHint;
  if (provider === "icloud") {
    return "iCloud 需在 Apple ID 开启双重认证并使用 app-specific password。";
  }

  if (provider === "outlook") {
    return "Outlook/Office365 可能禁用基础认证，建议 OAuth2 或在租户中允许 IMAP/SMTP AUTH。";
  }

  return "请检查邮箱是否开启 IMAP/SMTP，并确认账号密码或 OAuth2 token 可用。";
};

const resolveReadServer = (payload: ReadPayload) => {
  const provider = payload.provider ?? "gmail";
  const preset = provider === "custom" ? undefined : providerDefaults[provider];

  return {
    provider,
    host: payload.imapHost ?? preset?.imapHost,
    port: payload.imapPort ?? preset?.imapPort ?? 993,
  };
};

const resolveSendServer = (payload: SendPayload) => {
  const provider = payload.provider ?? "gmail";
  const preset = provider === "custom" ? undefined : providerDefaults[provider];
  const useTls = payload.useTls ?? true;

  return {
    provider,
    host: payload.smtpHost ?? preset?.smtpHost,
    port: payload.smtpPort ?? preset?.smtpPort ?? (useTls ? 465 : 587),
    useTls,
  };
};

const buildImapAuth = (payload: ReadPayload) => {
  const authMode = payload.authMode ?? "password";

  if (!payload.username) {
    return { error: "username is required" };
  }

  if (authMode === "oauth2") {
    if (!payload.accessToken) {
      return { error: "accessToken is required when authMode=oauth2" };
    }

    return {
      auth: {
        user: payload.username,
        accessToken: payload.accessToken,
      },
    };
  }

  if (!payload.password) {
    return { error: "password is required when authMode=password" };
  }

  return {
    auth: {
      user: payload.username,
      pass: payload.password,
    },
  };
};

const buildSmtpAuth = (payload: SendPayload) => {
  const authMode = payload.authMode ?? "password";

  if (!payload.username) {
    return { error: "username is required" };
  }

  if (authMode === "oauth2") {
    if (!payload.accessToken) {
      return { error: "accessToken is required when authMode=oauth2" };
    }

    return {
      auth: {
        type: "OAuth2" as const,
        user: payload.username,
        accessToken: payload.accessToken,
      },
    };
  }

  if (!payload.password) {
    return { error: "password is required when authMode=password" };
  }

  return {
    auth: {
      user: payload.username,
      pass: payload.password,
    },
  };
};

const readByImap = async (payload: ReadPayload) => {
  const { provider, host, port } = resolveReadServer(payload);

  if (!host) {
    return { error: "imapHost is required", hint: mailboxHint(provider) };
  }

  const authResult = buildImapAuth(payload);
  if ("error" in authResult) {
    return { error: authResult.error, hint: mailboxHint(provider) };
  }

  const folder = payload.folder ?? "INBOX";
  const includeBody = payload.includeBody ?? true;
  const limit = Math.max(1, Math.min(50, payload.limit ?? 5));
  const unseenOnly = payload.unseenOnly ?? false;

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: authResult.auth,
  });

  try {
    await client.connect();
    await client.mailboxOpen(folder);

    const sequence = await client.search(unseenOnly ? { seen: false } : {});
    const selected = sequence.slice(-limit).reverse();

    const messages = [];
    for await (const message of client.fetch(selected, {
      uid: true,
      envelope: true,
      source: true,
    })) {
      let body = "";
      if (includeBody && message.source) {
        const parsed = await simpleParser(message.source);
        body = parsed.text ?? "";
      }

      messages.push({
        id: String(message.uid),
        subject: message.envelope?.subject ?? "",
        from: message.envelope?.from?.map((x: { address?: string }) => x.address).filter(Boolean).join(", ") ?? "",
        to: message.envelope?.to?.map((x: { address?: string }) => x.address).filter(Boolean).join(", ") ?? "",
        date: message.envelope?.date?.toUTCString() ?? "",
        ...(includeBody ? { body } : {}),
      });
    }

    return {
      success: true,
      provider,
      count: messages.length,
      messages,
      folder,
      criteria: unseenOnly ? "UNSEEN" : "ALL",
      host,
      port,
    };
  } catch (error) {
    return {
      error: `IMAP read failed for ${provider}`,
      detail: error instanceof Error ? error.message : String(error),
      hint: mailboxHint(provider),
    };
  } finally {
    try {
      await client.logout();
    } catch {
      // noop
    }
  }
};

const sendBySmtp = async (payload: SendPayload) => {
  const { provider, host, port, useTls } = resolveSendServer(payload);

  if (!host) {
    return { error: "smtpHost is required", hint: mailboxHint(provider) };
  }

  if (!payload.to || payload.to.length === 0) {
    return { error: "at least one recipient in to is required" };
  }

  const authResult = buildSmtpAuth(payload);
  if ("error" in authResult) {
    return { error: authResult.error, hint: mailboxHint(provider) };
  }

  try {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure: useTls,
      auth: authResult.auth,
    });

    const from = payload.fromName
      ? `"${payload.fromName}" <${payload.username}>`
      : payload.username;

    const result = await transporter.sendMail({
      from,
      to: payload.to,
      cc: payload.cc,
      bcc: payload.bcc,
      subject: payload.subject ?? "",
      text: payload.text ?? "",
      html: payload.html,
    });

    return {
      success: true,
      provider,
      messageId: result.messageId,
      host,
      port,
      recipients: [
        ...(payload.to ?? []),
        ...(payload.cc ?? []),
        ...(payload.bcc ?? []),
      ],
    };
  } catch (error) {
    return {
      error: `SMTP send failed for ${provider}`,
      detail: error instanceof Error ? error.message : String(error),
      hint: mailboxHint(provider),
    };
  }
};

export const executeEmailAction = async (
  action: EmailAction,
  payload: Record<string, unknown>,
) => {
  try {
    if (action === "read") {
      return await readByImap(payload as ReadPayload);
    }

    if (action === "send") {
      return await sendBySmtp(payload as SendPayload);
    }

    return { error: `unsupported action: ${action}` };
  } catch (error) {
    return {
      error: `execute email ${action} failed`,
      detail: error instanceof Error ? error.message : String(error),
      hint: "请确认邮箱配置、认证方式与网络连通性。",
    };
  }
};
