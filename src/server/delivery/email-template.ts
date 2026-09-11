/**
 * The one HTML wrapper every outbound email uses.
 *
 * Outbound mail used to be `text:` only — every notification, whatever it
 * said, landed as a bare paragraph in whatever font the recipient's client
 * happened to default to. This is the missing half: a single, reusable
 * branded shell that `deliverOne` in delivery-service.ts wraps every EMAIL
 * body in.
 *
 * WHY THIS LOOKS LIKE 2005 HTML
 *
 * A `<style>` block is unreliable across mail clients — Gmail strips it in
 * some contexts, Outlook's Word rendering engine ignores large parts of
 * modern CSS entirely — so every rule here is an inline `style="…"`
 * attribute, and layout is a `<table>` rather than flexbox or grid, because
 * table layout is the one thing essentially every mail client still renders
 * correctly. This is not the CSS this codebase would write for a page; it is
 * the CSS that survives being rendered by software this codebase does not
 * control.
 *
 * The colours are not a fresh guess: they are the same tokens
 * `src/app/globals.css` defines and documents as AA/AAA-contrast-checked —
 * `--color-corn-600` (#216aca) as the one primary blue, `--color-corn-900` /
 * `--text-primary` (#0b2545) for the heading, `--text-secondary` (#4a5a75)
 * for body copy, `--text-tertiary` (#5f6f87) for the footer. An email that
 * used different blues than the site would be its own small trust problem —
 * the one artefact of this product many people read before they ever load
 * the site itself.
 *
 * No image is fetched or embedded: the mark is a unicode snowflake (❄) set on
 * an inline SVG circle, so the wordmark's motif survives with zero network
 * requests and zero attachment weight, and never triggers the "images
 * blocked by default" placeholder most clients show for a referenced image.
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PRIMARY = '#216aca';
const HEADING = '#0b2545';
const BODY_TEXT = '#4a5a75';
const FOOTER_TEXT = '#5f6f87';
const CARD_BG = '#ffffff';
const PAGE_BG = '#f1f5fb';
const BORDER = '#e4ebf5';
const FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

export function renderEmailHtml(
  subject: string,
  bodyText: string,
  opts?: { ctaUrl?: string; ctaLabel?: string; code?: string },
): string {
  const safeSubject = escapeHtml(subject);
  const safeBody = escapeHtml(bodyText);

  // A registration/OTP code, set large and letter-spaced so it reads
  // correctly at a glance and is unambiguous character-by-character when
  // typed back in — the one thing this block exists for.
  const codeBlock = opts?.code
    ? `
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:20px;">
                <tr>
                  <td align="center" style="padding:16px;background-color:${PAGE_BG};border-radius:12px;">
                    <span style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:32px;font-weight:700;letter-spacing:10px;color:${HEADING};">${escapeHtml(opts.code)}</span>
                  </td>
                </tr>
              </table>`
    : '';

  const cta =
    opts?.ctaUrl && opts.ctaLabel
      ? `
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
                <tr>
                  <td style="border-radius:12px;background-color:${PRIMARY};">
                    <a href="${escapeHtml(opts.ctaUrl)}"
                       style="display:inline-block;padding:12px 28px;font-family:${FONT_STACK};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:12px;">
                      ${escapeHtml(opts.ctaLabel)}
                    </a>
                  </td>
                </tr>
              </table>`
      : '';

  return `<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeSubject}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${PAGE_BG};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"
                 style="width:100%;max-width:560px;background-color:${CARD_BG};border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:24px 32px;background-color:${PRIMARY};">
                <table role="presentation" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <div style="width:28px;height:28px;border-radius:9999px;background-color:rgba(255,255,255,0.18);text-align:center;line-height:28px;font-size:15px;color:#ffffff;">❄</div>
                    </td>
                    <td style="vertical-align:middle;padding-left:10px;">
                      <span style="font-family:${FONT_STACK};font-size:18px;font-weight:700;color:#ffffff;">Кватэрка.by</span>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-family:${FONT_STACK};font-size:20px;line-height:1.35;font-weight:600;color:${HEADING};">
                  ${safeSubject}
                </h1>
                <p style="margin:0;font-family:${FONT_STACK};font-size:15px;line-height:1.6;color:${BODY_TEXT};">
                  ${safeBody}
                </p>${codeBlock}${cta}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;border-top:1px solid ${BORDER};">
                <p style="margin:0;font-family:${FONT_STACK};font-size:12px;line-height:1.6;color:${FOOTER_TEXT};">
                  Это письмо отправлено автоматически платформой Кватэрка.by. Если вы не ожидали его — просто проигнорируйте.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}
