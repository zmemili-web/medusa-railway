/**
 * Kulpix — iyzico Ödeme Sağlayıcısı (Medusa v2)
 * Durum: TASLAK. Backend ayağa kalkıp sandbox anahtarları girilince test edilecek.
 *
 * Akış: iyzico Checkout Form (3D Secure dahil). Sipariş onayında ödeme
 * iyzico'da başlatılır, müşteri iyzico formunda kartını girer, callback
 * ile sonuç doğrulanır.
 *
 * Gerekli paket: npm install iyzipay
 * Gerekli env: IYZICO_API_KEY, IYZICO_SECRET_KEY, IYZICO_BASE_URL
 *   Sandbox: https://sandbox-api.iyzipay.com
 *   Prod:    https://api.iyzipay.com
 */
import {
  AbstractPaymentProvider,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type {
  InitiatePaymentInput,
  InitiatePaymentOutput,
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  RefundPaymentInput,
  RefundPaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  ProviderWebhookPayload,
  WebhookActionResult,
} from "@medusajs/framework/types"

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Iyzipay = require("iyzipay")

type IyzicoOptions = {
  apiKey: string
  secretKey: string
  baseUrl: string
  callbackUrl: string // ör: https://kulpix.com/api/iyzico/callback
}

export default class IyzicoPaymentProviderService extends AbstractPaymentProvider<IyzicoOptions> {
  static identifier = "iyzico"

  protected client_: any
  protected options_: IyzicoOptions

  constructor(container: Record<string, unknown>, options: IyzicoOptions) {
    super(container, options)
    this.options_ = options
    this.client_ = new Iyzipay({
      apiKey: options.apiKey,
      secretKey: options.secretKey,
      uri: options.baseUrl,
    })
  }

  static validateOptions(options: Record<string, unknown>) {
    for (const k of ["apiKey", "secretKey", "baseUrl", "callbackUrl"]) {
      if (!options[k]) {
        throw new Error(`iyzico sağlayıcısı için '${k}' zorunlu`)
      }
    }
  }

  /** Ödeme oturumu başlat: iyzico Checkout Form initialize */
  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const { amount, currency_code, context } = input

    const request = {
      locale: "tr",
      conversationId: String(input.data?.session_id ?? Date.now()),
      price: String(amount),
      paidPrice: String(amount),
      currency: currency_code?.toUpperCase() === "TRY" ? Iyzipay.CURRENCY.TRY : currency_code?.toUpperCase(),
      basketId: String(input.data?.cart_id ?? "kulpix-sepet"),
      paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
      callbackUrl: this.options_.callbackUrl,
      // TODO: buyer / shippingAddress / billingAddress / basketItems
      // alanları cart context'inden doldurulacak (iyzico zorunlu tutar).
      ...buildBuyerAndBasket(context),
    }

    const result: any = await promisify(this.client_.checkoutFormInitialize.create.bind(this.client_.checkoutFormInitialize), request)

    if (result.status !== "success") {
      throw new Error(`iyzico başlatma hatası: ${result.errorMessage ?? result.errorCode}`)
    }

    return {
      id: result.token,
      data: {
        token: result.token,
        checkoutFormContent: result.checkoutFormContent,
        paymentPageUrl: result.paymentPageUrl,
      },
    }
  }

  /** Callback sonrası doğrulama: token ile ödeme sonucunu sorgula */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const token = (input.data?.token ?? "") as string
    const result: any = await promisify(this.client_.checkoutForm.retrieve.bind(this.client_.checkoutForm), {
      locale: "tr",
      token,
    })

    if (result.status === "success" && result.paymentStatus === "SUCCESS") {
      return {
        status: PaymentSessionStatus.CAPTURED, // iyzico checkout form öderken capture eder
        data: { ...input.data, paymentId: result.paymentId, raw: sanitize(result) },
      }
    }
    return { status: PaymentSessionStatus.ERROR, data: input.data ?? {} }
  }

  /** iyzico checkout form akışında ödeme zaten capture edilmiştir */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    // TODO: iyzico refund — paymentTransactionId bazında kısmi/tam iade.
    // this.client_.refund.create({...})
    throw new Error("İade akışı Faz 1 testlerinde tamamlanacak")
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    // Aynı gün iptal: this.client_.cancel.create({ paymentId })
    return { data: input.data ?? {} }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const token = (input.data?.token ?? "") as string
    if (!token) return { status: PaymentSessionStatus.PENDING }
    const result: any = await promisify(this.client_.checkoutForm.retrieve.bind(this.client_.checkoutForm), { locale: "tr", token })
    if (result.status === "success" && result.paymentStatus === "SUCCESS") {
      return { status: PaymentSessionStatus.CAPTURED }
    }
    return { status: PaymentSessionStatus.PENDING }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    // Tutar değişirse oturum yeniden başlatılır
    return await this.initiatePayment(input as unknown as InitiatePaymentInput)
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    // iyzico webhook: ödeme bildirimi. Faz 1'de callback endpoint ile birlikte test edilecek.
    return { action: "not_supported" }
  }
}

/* -------- yardımcılar -------- */

function promisify(fn: (req: any, cb: (err: any, res: any) => void) => void, req: any): Promise<any> {
  return new Promise((resolve, reject) => {
    fn(req, (err: any, res: any) => (err ? reject(err) : resolve(res)))
  })
}

/** iyzico'nun zorunlu tuttuğu buyer/adres/sepet alanları — cart context'inden doldurulur */
function buildBuyerAndBasket(context: any) {
  const c = context ?? {}
  const addr = c.billing_address ?? c.shipping_address ?? {}
  return {
    buyer: {
      id: c.customer?.id ?? "misafir",
      name: addr.first_name ?? "Ad",
      surname: addr.last_name ?? "Soyad",
      email: c.email ?? "musteri@kulpix.com",
      identityNumber: "11111111111", // TODO: TCKN alanı checkout'a eklenecek (fatura için)
      registrationAddress: addr.address_1 ?? "-",
      city: addr.city ?? "-",
      country: "Turkey",
      ip: c.ip ?? "0.0.0.0",
    },
    shippingAddress: {
      contactName: `${addr.first_name ?? ""} ${addr.last_name ?? ""}`.trim() || "Müşteri",
      city: addr.city ?? "-",
      country: "Turkey",
      address: addr.address_1 ?? "-",
    },
    billingAddress: {
      contactName: `${addr.first_name ?? ""} ${addr.last_name ?? ""}`.trim() || "Müşteri",
      city: addr.city ?? "-",
      country: "Turkey",
      address: addr.address_1 ?? "-",
    },
    basketItems: (c.items ?? []).map((it: any) => ({
      id: it.variant_id ?? it.id,
      name: it.title ?? "Ürün",
      category1: "Kulpix",
      itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
      price: String(it.total ?? it.unit_price),
    })),
  }
}

function sanitize(r: any) {
  const { checkoutFormContent, ...rest } = r ?? {}
  return rest
}
