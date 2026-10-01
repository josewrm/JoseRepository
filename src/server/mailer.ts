import nodemailer from "nodemailer";
import type { Mailer } from "../app/service.ts";

/**
 * SMTP transport for the Node host. Configured only through environment
 * variables, so no credential ever enters a protocol record or export:
 *   A2I_SMTP_URL   e.g. smtps://user:app-password@smtp.gmail.com:465
 *   A2I_SMTP_FROM  e.g. "Lucía Ejemplo <lucia@example.com>"
 * Without them the host hands the approved draft to the human instead.
 */
export function smtpMailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  const url = env.A2I_SMTP_URL;
  const from = env.A2I_SMTP_FROM;
  if (!url || !from) return undefined;
  const transport = nodemailer.createTransport(url);
  return async (message) => {
    const info = await transport.sendMail({
      from,
      to: message.to,
      subject: message.subject,
      text: message.body,
      attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content, contentType: "text/markdown; charset=utf-8" })),
    });
    return { id: String(info.messageId ?? "") };
  };
}
