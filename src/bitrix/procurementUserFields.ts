export interface ProcurementUserFieldSpec {
  FIELD_NAME: string;
  EDIT_FORM_LABEL: string;
  LIST_COLUMN_LABEL: string;
  USER_TYPE_ID: string;
  XML_ID: string;
  SORT: number;
}

/**
 * Пользовательские поля сделки, которых нет в базовой конфигурации Bitrix.
 *
 * Создаются отдельной командой с явным `--execute`, а не ежедневным прогоном: изменение схемы
 * портала не должно происходить как побочный эффект сбора данных.
 */
export const PROCUREMENT_USER_FIELDS: ProcurementUserFieldSpec[] = [
  {
    FIELD_NAME: "UF_CRM_PLAN_APPROVED_AT",
    EDIT_FORM_LABEL: "Дата утверждения плана",
    LIST_COLUMN_LABEL: "Дата утверждения плана",
    USER_TYPE_ID: "date",
    XML_ID: "scrape2lead_procurement_plan_approved_at",
    SORT: 540
  }
];

export interface UserFieldPlanItem {
  fieldName: string;
  action: "create" | "exists";
  fields: ProcurementUserFieldSpec;
}

/** Идемпотентно: поле, которое уже есть на портале, не пересоздаётся и не переписывается. */
export function planProcurementUserFields(
  existingFieldNames: string[],
  specs: ProcurementUserFieldSpec[] = PROCUREMENT_USER_FIELDS
): UserFieldPlanItem[] {
  const existing = new Set(existingFieldNames);
  return specs.map((spec) => ({
    fieldName: spec.FIELD_NAME,
    action: existing.has(spec.FIELD_NAME) ? "exists" : "create",
    fields: spec
  }));
}
