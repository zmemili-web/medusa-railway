import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { Modules } from "@medusajs/framework/utils"

const OLD_HOSTS = ["cdn.myikas.com", "static.ticimax.cloud"]

function pickMime(pathname: string): { mime: string; ext: string } {
  const p = pathname.toLowerCase()
  if (p.endsWith(".png")) return { mime: "image/png", ext: "png" }
  if (p.endsWith(".webp")) return { mime: "image/webp", ext: "webp" }
  if (p.endsWith(".gif")) return { mime: "image/gif", ext: "gif" }
  return { mime: "image/jpeg", ext: "jpg" }
}

export async function POST(req: MedusaRequest, res: MedusaResponse) {
  const q: any = req.query || {}
  const limit = Math.min(Number(q.limit ?? 3), 20)
  const offset = Number(q.offset ?? 0)
  const probe = String(q.probe ?? "") === "1"

  const productService: any = req.scope.resolve(Modules.PRODUCT)
  const fileService: any = req.scope.resolve(Modules.FILE)

  const products = await productService.listProducts(
    {},
    {
      select: ["id", "title", "thumbnail"],
      relations: ["images"],
      take: limit,
      skip: offset,
      order: { id: "ASC" },
    }
  )

  if (probe) {
    return res.json({
      probe: true,
      offset,
      limit,
      returned: products.length,
      sample: products.map((p: any) => ({
        id: p.id,
        thumb: (p.thumbnail || "").slice(0, 50),
        imgs: (p.images || []).length,
      })),
    })
  }

  const results: any[] = []
  for (const p of products) {
    const cache: Record<string, string> = {}
    let changed = false
    let idx = 0

    const migrateOne = async (url: string | null | undefined) => {
      if (!url) return url
      let host = ""
      try {
        host = new URL(url).hostname
      } catch (e) {
        return url
      }
      if (!OLD_HOSTS.includes(host)) return url
      if (cache[url]) return cache[url]
      const resp = await fetch(url)
      if (!resp.ok) throw new Error("download " + resp.status + " " + url)
      const buf = Buffer.from(await resp.arrayBuffer())
      const { mime, ext } = pickMime(new URL(url).pathname)
      const filename =
        p.id.replace("prod_", "") + "-" + idx++ + "." + ext
      const created = await fileService.createFiles([
        { filename, mimeType: mime, content: buf.toString("base64") },
      ])
      const newUrl = created[0].url
      cache[url] = newUrl
      changed = true
      return newUrl
    }

    try {
      const newThumb = await migrateOne(p.thumbnail)
      const imgs = p.images || []
      const newImgs: string[] = []
      for (const im of imgs) {
        newImgs.push((await migrateOne(im.url)) as string)
      }
      if (changed) {
        await productService.updateProducts(p.id, {
          thumbnail: newThumb,
          images: newImgs.map((u) => ({ url: u })),
        })
      }
      results.push({
        id: p.id,
        title: p.title,
        migrated: changed,
        imageCount: newImgs.length,
      })
    } catch (e: any) {
      results.push({ id: p.id, error: String(e?.message || e) })
    }
  }

  const nextOffset = offset + products.length
  res.json({
    offset,
    limit,
    processed: products.length,
    done: products.length < limit,
    nextOffset,
    results,
  })
}
