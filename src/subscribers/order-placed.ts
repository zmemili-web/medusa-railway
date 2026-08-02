import { SubscriberArgs, type SubscriberConfig } from "@medusajs/framework"
import { Modules } from "@medusajs/framework/utils"
import { Resend } from "resend"

// Medusa v2 BigNumber / number / string -> number
const toNum = (v: any): number => {
  if (v === null || v === undefined) return 0
  if (typeof v === "number") return v
  if (typeof v === "string") return parseFloat(v) || 0
  if (typeof v === "object") return toNum(v.numeric ?? v.value ?? v.raw?.value ?? 0)
  return 0
}

// ₺1.469,90 formatı (tr-TR)
const tl = (v: any): string =>
  "₺" +
  new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(toNum(v))

const esc = (s: any): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

export default async function orderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve("logger")

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) {
    logger.warn(
      "[order-placed] RESEND_API_KEY tanımlı değil; onay e-postası atlanıyor."
    )
    return
  }

  try {
    const orderService = container.resolve(Modules.ORDER)
    const order: any = await orderService.retrieveOrder(data.id, {
      relations: ["items", "shipping_address"],
    })

    if (!order?.email) {
      logger.warn(
        `[order-placed] Sipariş ${data.id} için e-posta adresi yok; atlanıyor.`
      )
      return
    }

    const displayId = order.display_id ? `#${order.display_id}` : order.id

    const items = order.items || []
    const itemsSubtotal = items.reduce(
      (s: number, it: any) => s + toNum(it.unit_price) * toNum(it.quantity),
      0
    )

    const rows = items
      .map((it: any) => {
        const line = toNum(it.unit_price) * toNum(it.quantity)
        const name = it.product_title
          ? `${esc(it.product_title)}${
              it.title && it.title !== it.product_title
                ? " - " + esc(it.title)
                : ""
            }`
          : esc(it.title)
        return `
          <tr>
            <td style="padding:12px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#111111;">
              ${name}
              <div style="color:#888888;font-size:12px;margin-top:2px;">Adet: ${esc(
                it.quantity
              )}</div>
            </td>
            <td style="padding:12px 0;border-bottom:1px solid #eeeeee;font-size:14px;color:#111111;text-align:right;white-space:nowrap;">
              ${tl(line)}
            </td>
          </tr>`
      })
      .join("")

    const a = order.shipping_address
    const addressHtml = a
      ? [
          `${esc(a.first_name)} ${esc(a.last_name)}`.trim(),
          esc(a.address_1),
          a.address_2 ? esc(a.address_2) : "",
          `${esc(a.postal_code)} ${esc(a.city)}${
            a.province ? " / " + esc(a.province) : ""
          }`.trim(),
          a.phone ? "Tel: " + esc(a.phone) : "",
        ]
          .filter(Boolean)
          .join("<br/>")
      : "-"

    const totalsRow = (label: string, value: string, bold = false): string => `
      <tr>
        <td style="padding:4px 0;font-size:${
          bold ? "16px" : "14px"
        };color:#111111;${bold ? "font-weight:700;" : ""}">${label}</td>
        <td style="padding:4px 0;font-size:${
          bold ? "16px" : "14px"
        };color:#111111;text-align:right;${
    bold ? "font-weight:700;" : ""
  }">${value}</td>
      </tr>`

    const discount = toNum(order.discount_total)

    const html = `<!doctype html>
<html lang="tr">
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:24px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border:1px solid #eeeeee;">
            <tr>
              <td style="background:#111111;padding:24px;text-align:center;">
                <span style="color:#ffffff;font-size:24px;font-weight:700;letter-spacing:3px;">KULPIX</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="margin:0 0 10px 0;font-size:22px;color:#111111;font-weight:700;">Siparişiniz alındı</h1>
                <p style="margin:0;font-size:14px;color:#555555;line-height:1.6;">
                  Merhaba, siparişiniz için teşekkür ederiz. Sipariş numaranız <strong>${esc(
                    displayId
                  )}</strong>. Aşağıda sipariş özetiniz yer alıyor.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  ${rows}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 16px 32px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-top:2px solid #111111;">
                  <tr><td colspan="2" style="height:8px;"></td></tr>
                  ${totalsRow("Ara toplam", tl(itemsSubtotal))}
                  ${totalsRow("Kargo", tl(order.shipping_total))}
                  ${discount > 0 ? totalsRow("İndirim", "-" + tl(discount)) : ""}
                  ${totalsRow("Toplam", tl(order.total), true)}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 24px 32px;">
                <h2 style="margin:0 0 8px 0;font-size:15px;color:#111111;font-weight:700;">Teslimat adresi</h2>
                <p style="margin:0;font-size:14px;color:#555555;line-height:1.6;">${addressHtml}</p>
              </td>
            </tr>
            <tr>
              <td style="background:#fafafa;padding:20px 32px;text-align:center;border-top:1px solid #eeeeee;">
                <p style="margin:0;font-size:12px;color:#999999;line-height:1.7;">
                  Kulpix · <a href="https://kulpix.com" style="color:#999999;text-decoration:none;">kulpix.com</a><br/>
                  Sorularınız için: <a href="mailto:info@kulpix.com" style="color:#999999;">info@kulpix.com</a>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`

    const resend = new Resend(apiKey)
    const { error } = await resend.emails.send({
      from: "Kulpix <info@kulpix.com>",
      to: [order.email],
      replyTo: "info@kulpix.com",
      subject: `Siparişiniz alındı - ${displayId}`,
      html,
    })

    if (error) {
      logger.error(`[order-placed] Resend hatası: ${JSON.stringify(error)}`)
      return
    }

    logger.info(
      `[order-placed] Onay e-postası gönderildi: ${order.email} (${displayId})`
    )
  } catch (e: any) {
    // Mail hatası siparişi bloklamaz; sipariş yine tamamlanır.
    logger.error(`[order-placed] E-posta gönderilemedi: ${e?.message || e}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
