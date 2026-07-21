/**
 * Kulpix - iyzico Odeme Saglayicisi (Medusa v2)
 * Akis: iyzico Checkout Form (3D Secure dahil).
 * initiatePayment -> iyzico'da form olusturulur, musteri paymentPageUrl'e yonlendirilir,
 * odeme sonrasi iyzico callbackUrl'e (vitrin /api/iyzico/callback) POST eder,
 * cart complete -> authorizePayment token ile sonucu dogrular.
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
  callbackUrl: string
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
        throw new Error("iyzico saglayicisi icin '" + k + "' zorunlu")
      }
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const { amount, currency_code } = input
    const d: any = input.data ?? {}

    const tutar = normalizeAmount(amount)
    if (!tutar || tutar <= 0) {
      throw new Error("iyzico: gecersiz tutar")
    }
    const tutarStr = tutar.toFixed(2)

    const cartId = String(d.cart_id ?? "kulpix-sepet")
    const cb =
      this.options_.callbackUrl +
      (this.options_.callbackUrl.indexOf("?") >= 0 ? "&" : "?") +
      "cart_id=" +
      encodeURIComponent(cartId)

    const ad = String(d.first_name ?? "Misafir")
    const soyad = String(d.last_name ?? "Musteri")
    const eposta = String(d.email ?? "musteri@kulpix.com")
    const adres = String(d.address_1 ?? "-")
    const sehir = String(d.city ?? "-")

    const request = {
      locale: "tr",
      conversationId: cartId,
      price: tutarStr,
      paidPrice: tutarStr,
      currency:
        (currency_code ?? "try").toUpperCase() === "TRY"
          ? Iyzipay.CURRENCY.TRY
          : (currency_code ?? "").toUpperCase(),
      basketId: cartId,
      paymentGroup: Iyzipay.PAYMENT_GROUP.PRODUCT,
      callbackUrl: cb,
      buyer: {
        id: String(d.customer_id ?? "misafir"),
        name: ad,
        surname: soyad,
        email: eposta,
        identityNumber: "11111111111",
        registrationAddress: adres,
        city: sehir,
        country: "Turkey",
        ip: String(d.ip ?? "85.34.78.112"),
      },
      shippingAddress: {
        contactName: (ad + " " + soyad).trim(),
        city: sehir,
        country: "Turkey",
        address: adres,
      },
      billingAddress: {
        contactName: (ad + " " + soyad).trim(),
        city: sehir,
        country: "Turkey",
        address: adres,
      },
      basketItems: [
        {
          id: cartId,
          name: "Kulpix Siparisi",
          category1: "Hirdavat",
          itemType: Iyzipay.BASKET_ITEM_TYPE.PHYSICAL,
          price: tutarStr,
        },
      ],
    }

    const result: any = await promisify(
      this.client_.checkoutFormInitialize.create.bind(this.client_.checkoutFormInitialize),
      request
    )

    if (result.status !== "success") {
      throw new Error(
        "iyzico baslatma hatasi: " + (result.errorMessage ?? result.errorCode)
      )
    }

    return {
      id: result.token,
      data: {
        token: result.token,
        paymentPageUrl: result.paymentPageUrl,
        cart_id: cartId,
      },
    }
  }

  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const token = (input.data?.token ?? "") as string
    if (!token) {
      return { status: PaymentSessionStatus.PENDING, data: input.data ?? {} }
    }
    const result: any = await promisify(
      this.client_.checkoutForm.retrieve.bind(this.client_.checkoutForm),
      { locale: "tr", token }
    )

    if (result.status === "success" && result.paymentStatus === "SUCCESS") {
      return {
        status: PaymentSessionStatus.CAPTURED,
        data: {
          ...(input.data ?? {}),
          paymentId: result.paymentId,
        },
      }
    }
    return { status: PaymentSessionStatus.PENDING, data: input.data ?? {} }
  }

  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    // TODO Faz 1: iyzico refund - paymentTransactionId bazinda kismi/tam iade
    throw new Error("Iade akisi henuz aktif degil; iyzico panelinden iade yapin")
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const token = (input.data?.token ?? "") as string
    if (!token) return { status: PaymentSessionStatus.PENDING }
    const result: any = await promisify(
      this.client_.checkoutForm.retrieve.bind(this.client_.checkoutForm),
      { locale: "tr", token }
    )
    if (result.status === "success" && result.paymentStatus === "SUCCESS") {
      return { status: PaymentSessionStatus.CAPTURED }
    }
    return { status: PaymentSessionStatus.PENDING }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const out = await this.initiatePayment(input as unknown as InitiatePaymentInput)
    return { data: out.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return { data: input.data ?? {} }
  }

  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    return { action: "not_supported" }
  }
}

function promisify(
  fn: (req: any, cb: (err: any, res: any) => void) => void,
  req: any
): Promise<any> {
  return new Promise((resolve, reject) => {
    fn(req, (err: any, res: any) => (err ? reject(err) : resolve(res)))
  })
}

function normalizeAmount(amount: any): number {
  if (amount == null) return 0
  if (typeof amount === "number") return amount
  if (typeof amount === "string") return parseFloat(amount)
  if (typeof amount === "object") {
    const v = amount.value ?? amount.numeric_ ?? amount.numeric
    if (v != null) return parseFloat(String(v))
  }
  const n = Number(amount)
  return isNaN(n) ? 0 : n
}
