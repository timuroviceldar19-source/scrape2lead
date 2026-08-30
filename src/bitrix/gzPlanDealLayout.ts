export interface GzDealLayoutElement {
  name: string;
  optionFlags: string;
  options?: Record<string, string>;
}

export interface GzDealLayoutSection {
  name: string;
  title: string;
  type: "section";
  elements: GzDealLayoutElement[];
}

export const GZ_PLAN_DETAILS_SECTION_NAME = "s2l_gz_plan_data";

/**
 * Fields already populated by bitrix-push-gz-deals.mts but missing from the
 * category-9 card layout. The list mirrors the procurement information visible
 * in the Electronic Shop card without replacing the category's sales fields.
 */
export const GZ_PLAN_DETAILS_FIELD_NAMES = [
  "UF_CRM_1782274598760",
  "UF_CRM_1782386080157_IU_XLS",
  "UF_CRM_1782386193634_IU_XLS",
  "UF_CRM_1782386244985_IU_XLS",
  "UF_CRM_1782386293000_IU_XLS",
  "UF_CRM_1782386433277_IU_XLS",
  "UF_CRM_1782386571874_IU_XLS",
  "UF_CRM_6A436D598EC82",
  "UF_CRM_6A436D59AACBF",
  "UF_CRM_6A436D59CD2B1",
  "UF_CRM_6A436D5A19612",
  "UF_CRM_6A436D5A3614C",
  "UF_CRM_6A436D5A5700E",
  "UF_CRM_6A436D5A76648",
  "UF_CRM_6A436D5A92D16",
  "UF_CRM_6A436D5AD0A2B",
  "UF_CRM_PLAN_ID",
  "UF_CRM_PLAN_LINK",
  "UF_CRM_PLAN_STATUS",
  "UF_CRM_MONTH",
  "UF_CRM_REF_ENSTRU_CODE",
  "UF_CRM_ENSTRU_NAME",
  "UF_CRM_UNIT_NAME",
  "UF_CRM_COUNT",
  "UF_CRM_PRICE_PER_UNIT",
  "UF_CRM_DELIVERY_ADDRESSES"
] as const;

function cloneSection(section: GzDealLayoutSection): GzDealLayoutSection {
  return {
    ...section,
    elements: (section.elements ?? []).map((element) => ({
      ...element,
      ...(element.options ? { options: { ...element.options } } : {})
    }))
  };
}

/** Adds the generated plan-data block while preserving every existing section. */
export function mergeGzPlanDetailsSection(
  configuration: readonly GzDealLayoutSection[]
): GzDealLayoutSection[] {
  const preserved = configuration
    .filter((section) => section.name !== GZ_PLAN_DETAILS_SECTION_NAME)
    .map(cloneSection);
  const visibleFields = new Set(
    preserved.flatMap((section) => section.elements.map((element) => element.name))
  );
  const elements = GZ_PLAN_DETAILS_FIELD_NAMES
    .filter((name) => !visibleFields.has(name))
    .map((name) => ({ name, optionFlags: "0" }));

  if (elements.length === 0) return preserved;
  return [
    ...preserved,
    {
      name: GZ_PLAN_DETAILS_SECTION_NAME,
      title: "Данные плана закупки",
      type: "section",
      elements
    }
  ];
}
