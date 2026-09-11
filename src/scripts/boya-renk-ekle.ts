import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createProductVariantsWorkflow,
  updateProductsWorkflow,
} from "@medusajs/medusa/core-flows"

import veri from "./boya-renkleri.json"

/**
 * Ahsap boya urunlerine renk secenegi ve renk x ambalaj varyantlari ekler.
 *
 * Kullanim:
 *   npx medusa exec ./src/scripts/boya-renk-ekle.ts -- --kuru
 *   npx medusa exec ./src/scripts/boya-renk-ekle.ts -- --urun=hemel-home
 *   npx medusa exec ./src/scripts/boya-renk-ekle.ts -- --hepsi
 *
 * --kuru  : hicbir sey degistirmez, ne yapacagini raporlar
 * --urun= : sadece o handle'i isler
 * --hepsi : tum urunleri isler
 *
 * Idempotent: var olan renk degeri ve varyant tekrar olusturulmaz.
 */

type RenkKaydi = { ad: string; swatch: string; buyuk: string }
type UrunKaydi = { urun: string; renkler: RenkKaydi[] }

const RENK_BASLIK = /renk|color/i
const AMBALAJ_BASLIK = /ambalaj|boy|\u00f6l\u00e7\u00fc|hacim|litre/i

function esle(s: string) {
  return String(s || "")
    .toLocaleUpperCase("tr")
    .replace(/\s+/g, " ")
    .trim()
}

function slug(s: string) {
  return s
    .toLowerCase()
    .replace(/\u0130/g, "i")
    .replace(/[\u00e7]/g, "c")
    .replace(/[\u011f]/g, "g")
    .replace(/[\u0131]/g, "i")
    .replace(/[\u00f6]/g, "o")
    .replace(/[\u015f]/g, "s")
    .replace(/[\u00fc]/g, "u")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export default async function boyaRenkEkle({ container, args }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const fileModule = container.resolve(Modules.FILE)

  const argDizi = Array.isArray(args) ? args : []
  logger.info("[boya-renk] gelen args: " + JSON.stringify(argDizi) + " | env BOYA_MOD=" + (process.env.BOYA_MOD || "-") + " BOYA_URUN=" + (process.env.BOYA_URUN || "-"))

  const kuru = argDizi.includes("--kuru") || process.env.BOYA_MOD === "kuru"
  const hepsi = argDizi.includes("--hepsi") || process.env.BOYA_MOD === "hepsi"
  const tekArg = argDizi.find((a) => a.startsWith("--urun="))
  const tekUrun = tekArg ? tekArg.split("=")[1] : (process.env.BOYA_URUN || null)

  if (!kuru && !hepsi && !tekUrun) {
    logger.error("[boya-renk] --kuru, --urun=<handle> veya --hepsi vermelisin.")
    return
  }

  const kayitlar = (veri as UrunKaydi[]).filter((k) =>
    tekUrun ? k.urun === tekUrun : true
  )

  logger.info(
    `[boya-renk] ${kayitlar.length} urun islenecek. Mod: ${kuru ? "KURU" : "GERCEK"}`
  )

  let toplamYeniRenk = 0
  let toplamYeniVaryant = 0
  let toplamGorsel = 0

  for (const kayit of kayitlar) {
    const { data: urunler } = await query.graph({
      entity: "product",
      fields: [
        "id",
        "handle",
        "title",
        "options.id",
        "options.title",
        "options.values.id",
        "options.values.value",
        "variants.id",
        "variants.title",
        "variants.metadata",
        "variants.options.value",
        "variants.options.option_id",
        "variants.prices.amount",
        "variants.prices.currency_code",
      ],
      filters: { handle: kayit.urun },
    })

    const urun = urunler?.[0]
    if (!urun) {
      logger.warn(`[boya-renk] urun bulunamadi: ${kayit.urun}`)
      continue
    }

    const renkOpt = (urun.options || []).find((o: any) =>
      RENK_BASLIK.test(o.title || "")
    )
    const ambalajOpt = (urun.options || []).find(
      (o: any) => !RENK_BASLIK.test(o.title || "") && AMBALAJ_BASLIK.test(o.title || "")
    )

    if (!renkOpt) {
      logger.warn(`[boya-renk] ${kayit.urun}: Renk secenegi yok, atlandi`)
      continue
    }
    if (!ambalajOpt) {
      logger.warn(`[boya-renk] ${kayit.urun}: Ambalaj secenegi yok, atlandi`)
      continue
    }

    // normalize edilmis anahtar -> Medusa'daki gercek yazim
    const mevcutRenkHarita = new Map<string, string>()
    for (const v of renkOpt.values || []) {
      mevcutRenkHarita.set(esle(String(v.value)), String(v.value))
    }
    const ambalajlar = (ambalajOpt.values || []).map((v: any) => String(v.value))

    const yeniRenkler = kayit.renkler.filter(
      (r) => !mevcutRenkHarita.has(esle(r.ad))
    )

    // her renk icin Medusa'da kullanilacak nihai yazim
    const yazim = (ad: string) => mevcutRenkHarita.get(esle(ad)) || ad

    // mevcut varyantlari renk|ambalaj anahtariyla haritala
    const varAnahtar = new Set<string>()
    const ambalajFiyat = new Map<string, any[]>()
    for (const v of urun.variants || []) {
      const renkDeg = (v.options || []).find(
        (o: any) => o.option_id === renkOpt.id
      )?.value
      const ambDeg = (v.options || []).find(
        (o: any) => o.option_id === ambalajOpt.id
      )?.value
      if (renkDeg && ambDeg) varAnahtar.add(esle(renkDeg) + "|" + esle(ambDeg))
      if (ambDeg && !ambalajFiyat.has(ambDeg)) {
        ambalajFiyat.set(
          ambDeg,
          (v.prices || []).map((p: any) => ({
            amount: p.amount,
            currency_code: p.currency_code,
          }))
        )
      }
    }

    const eksikVaryantlar: { renk: RenkKaydi; ambalaj: string }[] = []
    for (const r of kayit.renkler) {
      for (const a of ambalajlar) {
        if (!varAnahtar.has(esle(r.ad) + "|" + esle(a))) {
          eksikVaryantlar.push({ renk: r, ambalaj: a })
        }
      }
    }

    logger.info(
      `[boya-renk] ${kayit.urun}: ${kayit.renkler.length} renk, ${ambalajlar.length} ambalaj | yeni renk ${yeniRenkler.length}, eksik varyant ${eksikVaryantlar.length}`
    )

    toplamYeniRenk += yeniRenkler.length
    toplamYeniVaryant += eksikVaryantlar.length

    if (kuru) continue
    if (!yeniRenkler.length && !eksikVaryantlar.length) continue

    // 1) Renk secenegine yeni degerleri ekle (mevcutlari koruyarak)
    if (yeniRenkler.length) {
      const tumOptions = (urun.options || []).map((o: any) => {
        const degerler = (o.values || []).map((v: any) => String(v.value))
        if (o.id === renkOpt.id) {
          return {
            title: o.title,
            values: [...degerler, ...yeniRenkler.map((r) => r.ad)],
          }
        }
        return { title: o.title, values: degerler }
      })

      await updateProductsWorkflow(container).run({
        input: {
          selector: { id: urun.id },
          update: { options: tumOptions },
        },
      })
      logger.info(`[boya-renk] ${kayit.urun}: ${yeniRenkler.length} renk degeri eklendi`)
    }

    // 2) Renk gorsellerini R2'ye yukle
    const gorselUrl = new Map<string, string>()
    const gerekliRenkler = Array.from(
      new Set(eksikVaryantlar.map((e) => e.renk.ad))
    )
    for (const renkAdi of gerekliRenkler) {
      const r = kayit.renkler.find((x) => x.ad === renkAdi)!
      try {
        const cevap = await fetch(r.buyuk)
        if (!cevap.ok) {
          logger.warn(`[boya-renk] gorsel indirilemedi (${cevap.status}): ${r.buyuk}`)
          continue
        }
        const buf = Buffer.from(await cevap.arrayBuffer())
        const uzanti = (r.buyuk.split(".").pop() || "jpg").split("?")[0]
        const [dosya] = await fileModule.createFiles([
          {
            filename: `${kayit.urun}-${slug(renkAdi)}.${uzanti}`,
            mimeType: uzanti === "png" ? "image/png" : "image/jpeg",
            content: buf.toString("base64"),
            access: "public" as any,
          },
        ])
        gorselUrl.set(renkAdi, dosya.url)
        toplamGorsel++
      } catch (e: any) {
        logger.warn(
          `[boya-renk] gorsel yuklenemedi ${renkAdi}: ${e?.message || e}`
        )
      }
    }

    // 3) Eksik varyantlari olustur
    const yeniVaryantlar = eksikVaryantlar.map((e) => {
      const fiyatlar = ambalajFiyat.get(e.ambalaj) || []
      return {
        title: `${yazim(e.renk.ad)} / ${e.ambalaj}`,
        options: {
          [renkOpt.title]: yazim(e.renk.ad),
          [ambalajOpt.title]: e.ambalaj,
        },
        prices: fiyatlar,
        manage_inventory: false,
        metadata: gorselUrl.has(e.renk.ad)
          ? { thumbnail: gorselUrl.get(e.renk.ad) }
          : {},
      }
    })

    // 50'serli parcalar halinde olustur
    for (let i = 0; i < yeniVaryantlar.length; i += 50) {
      const parca = yeniVaryantlar.slice(i, i + 50)
      await createProductVariantsWorkflow(container).run({
        input: {
          product_variants: parca.map((v) => ({ ...v, product_id: urun.id })),
        } as any,
      })
      logger.info(
        `[boya-renk] ${kayit.urun}: ${parca.length} varyant olusturuldu (${i + parca.length}/${yeniVaryantlar.length})`
      )
    }
  }

  logger.info(
    `[boya-renk] BITTI. Yeni renk: ${toplamYeniRenk}, yeni varyant: ${toplamYeniVaryant}, yuklenen gorsel: ${toplamGorsel}`
  )
}
