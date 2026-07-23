export interface ProcurementDealLayoutElement {
  name: string;
  optionFlags: string;
  options?: Record<string, string>;
}

export interface ProcurementDealLayoutSection {
  name: string;
  title: string;
  type: "section";
  elements: ProcurementDealLayoutElement[];
}

const element = (name: string, options?: Record<string, string>): ProcurementDealLayoutElement => ({
  name,
  optionFlags: "0",
  ...(options ? { options } : {})
});

export function buildProcurementDealConfiguration(): ProcurementDealLayoutSection[] {
  return [
    {
      name: "procurement_main", title: "О закупке", type: "section", elements: [
        element("TITLE"), element("STAGE_ID"),
        element("OPPORTUNITY_WITH_CURRENCY", { isPayButtonVisible: "false", isPaymentDocumentsVisible: "false" })
      ]
    },
    {
      name: "procurement_customer", title: "Заказчик", type: "section", elements: [
        element("UF_CRM_6627AEBD72587"), element("UF_CRM_6627AEBD7C2D2"),
        element("UF_CRM_6A436D598EC82"), element("UF_CRM_6A436D59AACBF"), element("UF_CRM_6A436D59CD2B1"),
        element("UF_CRM_1782274598760")
      ]
    },
    {
      name: "procurement_parameters", title: "Параметры закупки", type: "section", elements: [
        element("SOURCE_DESCRIPTION"), element("UF_CRM_POINT_TYPE"), element("UF_CRM_PLAN_STATUS"),
        element("UF_CRM_6627AEBD4503E"), element("UF_CRM_TRADE_METHOD"), element("BEGINDATE"),
        element("UF_CRM_1782386293000_IU_XLS"), element("UF_CRM_6A436D5A3614C"), element("UF_CRM_PLAN_LINK")
      ]
    },
    {
      name: "procurement_product", title: "Товар и характеристики", type: "section", elements: [
        element("UF_CRM_REF_ENSTRU_CODE"), element("UF_CRM_ENSTRU_NAME"), element("UF_CRM_REF_SUBJECT_TYPE_NAME"),
        element("UF_CRM_DESC_RU"), element("UF_CRM_DESC_KZ"), element("UF_CRM_EXTRA_DESC_RU"),
        element("UF_CRM_UNIT_NAME"), element("UF_CRM_COUNT"), element("UF_CRM_PRICE_PER_UNIT"),
        element("UF_CRM_PREPAYMENT"), element("UF_CRM_SUPPLY_DATE")
      ]
    },
    {
      name: "procurement_delivery", title: "Поставка", type: "section", elements: [
        element("UF_CRM_DELIVERY_ADDRESSES")
      ]
    },
    {
      name: "procurement_service", title: "Служебное", type: "section", elements: [
        element("OPENED"), element("ASSIGNED_BY_ID"), element("COMMENTS")
      ]
    }
  ];
}
