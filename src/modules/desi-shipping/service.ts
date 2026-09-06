import { AbstractFulfillmentProviderService } from "@medusajs/framework/utils"

/**
 * Desi bazlı kargo hesaplama.
 * variant.weight = kg. Sepetin toplam kg'si = desi (yukarı yuvarlanır, min 1).
 * Dönen tutar KDV %20 DAHİL (müşteri bunu öder).
 */

// KDV %20 dahil tarife (₺)
function desiPrice(totalKg: number): number {
  const d = Math.max(1, Math.ceil(totalKg))
  if (d === 1) return 167.76
  if (d === 2) return 176.4
  if (d === 3) return 185.04
  if (d === 4) return 196.32
  if (d === 5) return 212.4
  if (d <= 10) return 254.4
  if (d <= 15) return 348.66
  if (d <= 20) return 462.66
  if (d <= 25) return 578.34
  if (d <= 30) return 693.96
  // 31+ : desi başına 23,14 (19,28 + %20)
  return Math.round(d * 23.136 * 100) / 100
}

// --- Ucretsiz kargo esigi -------------------------------------------------
// Esik SADECE bu kategorilerdeki kalemlerin toplamina bakar. Ahsap boya haric.
const FREE_SHIPPING_CATEGORIES = ["Kulp", "Kapi Kolu", "Kapı Kolu"]

// Esik FREE_SHIPPING_THRESHOLD ortam degiskeninden okunur (KDV DAHIL tutar).
// Degisken tanimli degilse kural CALISMAZ, kargo eskisi gibi hesaplanir.
// Boylece kod canliya alinsa bile davranis env girilene kadar degismez.
function freeShippingThreshold(): number | null {
  const raw = process.env.FREE_SHIPPING_THRESHOLD
  if (!raw) return null
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : null
}

class DesiShippingProviderService extends AbstractFulfillmentProviderService {
  static identifier = "desi-shipping"

  protected container_: any

  constructor(container: any) {
    super()
    this.container_ = container
  }

  async getFulfillmentOptions(): Promise<any[]> {
    return [
      {
        id: "desi-standard",
        name: "Standart Kargo (Desi)",
      },
    ]
  }

  async validateFulfillmentData(
    optionData: any,
    data: any,
    context: any
  ): Promise<any> {
    return data ?? {}
  }

  async validateOption(data: any): Promise<boolean> {
    return true
  }

  async canCalculate(data: any): Promise<boolean> {
    return true
  }

  async calculatePrice(
    optionData: any,
    data: any,
    context: any
  ): Promise<any> {
    const items: any[] = context?.items || []

    // variant ağırlıklarını topla
    const weightById: Record<string, number> = {}
    const categoryNamesById: Record<string, string[]> = {}
    const catDiag: any = {}
    const variantIds = Array.from(
      new Set(items.map((i) => i?.variant_id).filter(Boolean))
    )

    if (variantIds.length) {
      try {
        const query = this.container_.resolve("query")
        const { data: variants } = await query.graph({
          entity: "product_variant",
          fields: ["id", "weight", "product_id"],
          filters: { id: variantIds },
        })
        catDiag.varyantAnahtarlari = Object.keys((variants || [])[0] || {})
        catDiag.varyantSayisi = (variants || []).length
        const productIdByVariant: Record<string, string> = {}
        const productIds: string[] = []
        for (const v of variants || []) {
          weightById[v.id] = Number(v.weight) || 0
          categoryNamesById[v.id] = []
          const pid = String((v as any)?.product_id || "")
          if (pid) {
            productIdByVariant[v.id] = pid
            if (!productIds.includes(pid)) productIds.push(pid)
          }
        }

        // Kategori adlari: once product uzerinden, olmazsa product_category
        // uzerinden dene. Hangi yolun calistigini catDiag ile raporla.
        catDiag.productIdSayisi = productIds.length
        if (productIds.length) {
          const catsByProduct: Record<string, string[]> = {}
          try {
            const { data: products } = await query.graph({
              entity: "product",
              fields: ["id", "categories.name"],
              filters: { id: productIds },
            })
            catDiag.yol = "product"
            catDiag.donenUrun = (products || []).length
            catDiag.ilkAnahtarlar = Object.keys((products || [])[0] || {})
            for (const p of products || []) {
              catsByProduct[p.id] = ((p as any)?.categories || [])
                .map((c: any) => String(c?.name || ""))
                .filter(Boolean)
            }
          } catch (e: any) {
            catDiag.productHatasi = String(e?.message || e).slice(0, 200)
          }

          const bulundu = Object.values(catsByProduct).some((a) => a.length)
          if (!bulundu) {
            try {
              const { data: cats } = await query.graph({
                entity: "product_category",
                fields: ["id", "name", "products.id"],
              })
              catDiag.yol = "product_category"
              catDiag.donenKategori = (cats || []).length
              for (const c of cats || []) {
                const nm = String((c as any)?.name || "")
                for (const p of ((c as any)?.products || [])) {
                  const pid = String(p?.id || "")
                  if (!pid || !productIds.includes(pid)) continue
                  catsByProduct[pid] = catsByProduct[pid] || []
                  if (nm && !catsByProduct[pid].includes(nm)) {
                    catsByProduct[pid].push(nm)
                  }
                }
              }
            } catch (e: any) {
              catDiag.kategoriHatasi = String(e?.message || e).slice(0, 200)
            }
          }

          for (const vid of Object.keys(productIdByVariant)) {
            categoryNamesById[vid] = catsByProduct[productIdByVariant[vid]] || []
          }
        }
      } catch (e) {
        // ağırlık çekilemezse item üstündeki veriye düş
      }
    }

    // --- Ucretsiz kargo esigi kontrolu ---
    // Sadece Kulp + Kapi Kolu kalemlerinin KDV DAHIL toplamina bakilir.
    const threshold = freeShippingThreshold()
    if (threshold !== null) {
      let qualifyingTotal = 0
      const diag: any[] = []
      for (const it of items) {
        const cats = categoryNamesById[it?.variant_id] || []
        const qualifies = cats.some((c) => FREE_SHIPPING_CATEGORIES.includes(c))
        const qty = Number(it?.quantity) || 1
        // it.total varsa KDV DAHIL satir toplamidir; yoksa unit_price * adet.
        // Urun fiyatlari KDV dahil saklandigi icin unit_price da KDV dahildir.
        const lineTotal =
          typeof it?.total === "number"
            ? it.total
            : (Number(it?.unit_price) || 0) * qty
        if (qualifies) qualifyingTotal += lineTotal
        diag.push({
          itemKeys: Object.keys(it || {}),
          it_product_id: it?.product_id,
          it_variant_product_id: it?.variant?.product_id,
          cats,
          qualifies,
          qty,
          unit_price: it?.unit_price,
          total: it?.total,
          subtotal: it?.subtotal,
          lineTotal,
        })
      }
      // Gecici teshis logu: birim ve alan secimini dogrulamak icin.
      console.log(
        "[desi] esik kontrolu " +
          JSON.stringify({ threshold, qualifyingTotal, catDiag, diag })
      )
      if (qualifyingTotal >= threshold) {
        return {
          calculated_amount: 0,
          is_calculated_price_tax_inclusive: true,
        }
      }
    }

    // weight gram cinsinden saklanıyor (Medusa integer alan); kg = gram / 1000
    let totalGrams = 0
    for (const it of items) {
      const w =
        weightById[it?.variant_id] ??
        Number(it?.variant?.weight) ??
        Number(it?.product?.weight) ??
        0
      const qty = Number(it?.quantity) || 1
      totalGrams += (Number(w) || 0) * qty
    }
    const totalKg = totalGrams / 1000

    return {
      // KDV dahil tutar, küsuratsız olması için yukarı yuvarlanır (tam TL)
      calculated_amount: Math.ceil(desiPrice(totalKg)),
      is_calculated_price_tax_inclusive: true,
    }
  }

  // --- Zorunlu stub'lar (manuel operasyon; etiket/entegrasyon yok) ---
  async createFulfillment(
    data: any,
    items: any,
    order: any,
    fulfillment: any
  ): Promise<any> {
    return { data: data ?? {}, labels: [] }
  }

  async cancelFulfillment(fulfillment: any): Promise<any> {
    return {}
  }

  async createReturnFulfillment(fulfillment: any): Promise<any> {
    return { data: {}, labels: [] }
  }
}

export default DesiShippingProviderService
