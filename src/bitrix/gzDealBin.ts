export interface DealWithBin {
  COMPANY_ID?: string | number | null;
  UF_CRM_6627AEBD7C2D2?: string | null;
  COMMENTS?: string | null;
}

export function gzDealBin(deal: DealWithBin, companyBins: ReadonlyMap<string, string> = new Map()): string | null {
  const own = String(deal.UF_CRM_6627AEBD7C2D2 ?? '').trim();
  if (/^\d{12}$/.test(own)) return own;
  const comment = /BIN:\s*(\d{12})/.exec(deal.COMMENTS ?? '')?.[1];
  const bin = comment ?? companyBins.get(String(deal.COMPANY_ID ?? '')) ?? '';
  return /^\d{12}$/.test(bin) ? bin : null;
}

export async function loadCompanyBins(deals: DealWithBin[], call: (ids: string[]) => Promise<unknown>): Promise<Map<string, string>> {
  const ids = [...new Set(deals.filter(deal => !gzDealBin(deal)).map(deal => String(deal.COMPANY_ID ?? '')).filter(id => /^[1-9]\d*$/.test(id)))];
  const bins = new Map<string, string>();
  for (let start = 0; start < ids.length; start += 50) {
    const batch = ids.slice(start, start + 50);
    const result = await call(batch);
    if (!Array.isArray(result)) throw new Error('crm.company.list: expected an array');
    for (const company of result) {
      const bin = String(company.UF_CRM_666171B20E9E3 ?? '').replace(/\D/g, '');
      if (batch.includes(String(company.ID)) && /^\d{12}$/.test(bin)) bins.set(String(company.ID), bin);
    }
  }
  return bins;
}
