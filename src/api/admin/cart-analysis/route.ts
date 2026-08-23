import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"

// GECICI, SALT-OKUNUR cart funnel analizi. Sadece SELECT. Analiz bitince silinecek.
export async function GET(req: MedusaRequest, res: MedusaResponse) {
  const knex: any = req.scope.resolve(ContainerRegistrationKeys.PG_CONNECTION)
  const out: any = {}
  const run = async (key: string, sql: string) => {
    try {
      const r = await knex.raw(sql)
      out[key] = r.rows
    } catch (e: any) {
      out[key] = { error: e.message }
    }
  }

  await run("tables", "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'cart%' OR table_name LIKE 'order%' OR table_name='customer') ORDER BY 1")
  await run("cart_cols", "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='cart' ORDER BY 1")
  await run("li_cols", "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='cart_line_item' ORDER BY 1")
  await run("funnel", "WITH c AS (SELECT c.id, c.email, c.completed_at, c.created_at, c.shipping_address_id, (COALESCE(c.email,'') IN ('zmemili@gmail.com','test@kulpix.com') OR COALESCE(cu.email,'') IN ('zmemili@gmail.com','test@kulpix.com')) AS is_test FROM cart c LEFT JOIN customer cu ON cu.id=c.customer_id WHERE c.created_at >= '2026-08-15' AND c.deleted_at IS NULL), li AS (SELECT cart_id, COUNT(*) n FROM cart_line_item WHERE deleted_at IS NULL GROUP BY cart_id) SELECT c.is_test, COUNT(*) carts, COUNT(*) FILTER (WHERE li.n>0) with_items, COUNT(*) FILTER (WHERE c.email IS NOT NULL) with_email, COUNT(*) FILTER (WHERE c.shipping_address_id IS NOT NULL) with_address, COUNT(*) FILTER (WHERE c.completed_at IS NOT NULL) completed FROM c LEFT JOIN li ON li.cart_id=c.id GROUP BY c.is_test ORDER BY c.is_test")
  await run("daily", "SELECT to_char(c.created_at,'YYYY-MM-DD') day, COUNT(*) carts, COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM cart_line_item li WHERE li.cart_id=c.id AND li.deleted_at IS NULL)) with_items FROM cart c WHERE c.created_at >= '2026-08-15' AND c.deleted_at IS NULL GROUP BY 1 ORDER BY 1")
  await run("items", "SELECT li.title, li.variant_id, COUNT(DISTINCT li.cart_id) carts, SUM(li.quantity) qty FROM cart_line_item li JOIN cart c ON c.id=li.cart_id WHERE c.created_at >= '2026-08-15' AND c.deleted_at IS NULL AND li.deleted_at IS NULL GROUP BY 1,2 ORDER BY carts DESC LIMIT 50")
  await run("detail", "SELECT to_char(c.created_at,'YYYY-MM-DD HH24:MI') created, c.email, (c.completed_at IS NOT NULL) completed, (c.shipping_address_id IS NOT NULL) has_addr, (SELECT COUNT(*) FROM cart_line_item li WHERE li.cart_id=c.id AND li.deleted_at IS NULL) items FROM cart c LEFT JOIN customer cu ON cu.id=c.customer_id WHERE c.created_at >= '2026-08-15' AND c.deleted_at IS NULL ORDER BY c.created_at LIMIT 300")

  res.json(out)
}
