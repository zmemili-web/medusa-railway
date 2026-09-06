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
const FREE_SHIPPING_HANDLE_PREFIXES = ["kulpix-kulp-", "kulpix-kol-"]

// Esik FREE_SHIPPING_THRESHOLD ortam degiskeninden okunur (KDV DAHIL tutar).
// Degisken tanimli degilse kural CALISMAZ, kargo eskisi gibi hesaplanir.
// Boylece kod canliya alinsa bile davranis env girilene kadar degismez.
// Container Medusa'da Awilix proxy'si olabilir: .resolve("query") her zaman
// calismiyor ("Could not resolve 'resolve'"). Once dogrudan ozellik, sonra resolve.
function resolveQuery(container: any): any {
  if (!container) return null
  if (container.query) return container.query
  if (typeof container.resolve === "function") {
    try {
      return container.resolve("query")
    } catch (e) {
      return null
    }
  }
  return null
}

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
    const variantIds = Array.from(
      new Set(items.map((i) => i?.variant_id).filter(Boolean))
    )

    if (variantIds.length) {
      try {
        const query = resolveQuery(this.container_ as any)
        const { data: variants } = await query.graph({
          entity: "product_variant",
          fields: ["id", "weight", "product_id"],
          filters: { id: variantIds },
        })
        for (const v of variants || []) {
          weightById[v.id] = Number(v.weight) || 0
        }
      } catch (e) {
        // agirlik cekilemezse item ustundeki veriye dus
      }
    }

    // --- Ucretsiz kargo esigi kontrolu ---
    // Kategori SORGUSU KULLANILMIYOR. Medusa container'i bu modulde query'yi
    // cozumleyemiyor, o yuzden sepet kaleminde HAZIR gelen product_handle
    // uzerinden ayrim yapiyoruz. Katalogda dogrulandi (06.09.2026):
    //   kulpix-kulp-*  -> 24/24 Kulp urunu
    //   kulpix-kol-*   ->   8/8 Kapi Kolu urunu
    //   Ahsap boyalarin hicbiri "kulpix-" ile baslamiyor (73 urun), cakisma yok.
    // YENI URUN EKLERKEN: kulp icin handle "kulpix-kulp-", kapi kolu icin
    // "kulpix-kol-" ile baslamali, yoksa urun kampanyaya dahil olmaz.
    const threshold = freeShippingThreshold()
    if (threshold !== null) {
      let qualifyingTotal = 0
      const diag: any[] = []
      for (const it of items) {
        const handle = String(it?.product_handle || "").toLowerCase()
        const qualifies = FREE_SHIPPING_HANDLE_PREFIXES.some((p) =>
          handle.startsWith(p)
        )
        const qty = Number(it?.quantity) || 1
        // unit_price KDV DAHIL saklanir (musterinin gordugu fiyat).
        const lineTotal =
          typeof it?.total === "number"
            ? it.total
            : (Number(it?.unit_price) || 0) * qty
        if (qualifies) qualifyingTotal += lineTotal
        diag.push({ handle, qualifies, qty, lineTotal })
      }

      console.log(
        "[desi] esik kontrolu " +
          JSON.stringify({ threshold, qualifyingTotal, diag })
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
