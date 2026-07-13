import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import IyzicoPaymentProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [IyzicoPaymentProviderService],
})
