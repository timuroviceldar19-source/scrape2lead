import { it, expect } from 'vitest';
import { calculateDailyMetrics } from '../../src/bitrix/salesPult/metrics.js';
it('does not count a CRM win contradicted by portal lost outcome', () => {
 const deals = new Map([['demo',{id:'demo',title:'Тест',amount:10,assignedById:'m',stageSemanticId:'S',outcome:'lost:other'}]]);
 const result=calculateDailyMetrics({managerId:'m',date:'2026-10-23',calls:[],kpTransitions:[],contractTransitions:[{id:'h',dealId:'demo',stageId:'WON',createdTime:'2026-10-23T12:00:00+05:00'}],deals});
 expect(result.contracts.uniqueDealsCount).toBe(0);
});
