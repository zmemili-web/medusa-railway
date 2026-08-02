import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import DesiShippingProviderService from "./service"

export default ModuleProvider(Modules.FULFILLMENT, {
  services: [DesiShippingProviderService],
})
