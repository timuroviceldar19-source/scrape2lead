import { it, expect, vi } from 'vitest';
import { collectPultData } from '../../src/bitrix/salesPult/collect.js';
import type { ReadOnlyBitrixClient } from '../../src/bitrix/reporting/readOnlyClient.js';
it('collects older CRM wins contradicted by portal even outside current month transitions', async () => {
 const client={call:vi.fn(async()=>[]),listAllBatched:vi.fn(async(method:string,params:{filter?:Record<string,unknown>})=>params.filter?.['%UF_CRM_S2L_GZ_OUTCOME']==='lost:' ? [{ID:'demo-lost',TITLE:'Выдуманная сделка',ASSIGNED_BY_ID:'m',STAGE_SEMANTIC_ID:'S',STAGE_ID:'C9:WON',UF_CRM_S2L_GZ_OUTCOME:'lost:other',CLOSEDATE:'2026-09-01'}]:[])};
 const result=await collectPultData({client:client as unknown as ReadOnlyBitrixClient,fromDate:'2026-10-26',toDate:'2026-11-01',managerIds:['m'],proposalStages:[],contractStages:[]});
 expect(result.deals.get('demo-lost')?.outcome).toBe('lost:other');
});
