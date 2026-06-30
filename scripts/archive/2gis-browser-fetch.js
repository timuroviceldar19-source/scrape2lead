// === 2GIS Contact Fetcher ===
// Paste this into Chrome DevTools Console while on ANY 2gis.kz page
// It uses the internal API key from the page context
// 
// USAGE: Replace the `firmIds` array with IDs from step 1
// Or paste the full JSON array from 2gis-firm-urls.json

const API_KEY = 'c7f1a769-c8a5-4636-b14d-d8c987808a12';
const FIELDS = 'items.contact_groups,items.name_ex,items.adm_div,items.address_name,items.rubrics,items.point,items.org,items.site,items.schedule,items.reviews,items.description,items.source_url';
const DELAY_MS = 2000;

// === PASTE YOUR FIRM IDS HERE ===
const firmIds = [
  // Example: '70000001066224474', '70000001045451501', ...
  // Or load from clipboard: JSON.parse(prompt('Paste JSON array of firm objects'))
];
// === END ===

async function fetchFirm(id) {
  const url = `https://catalog.api.2gis.ru/3.0/items/byid?id=${id}&key=${API_KEY}&fields=${FIELDS}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (data.meta?.error) return { id, error: data.meta.error.message };
  const item = data.result?.items?.[0];
  if (!item) return { id, error: 'no item' };

  const contacts = (item.contact_groups || []).flatMap(g => 
    (g.contacts || []).map(c => ({ type: c.type, value: c.value || c.url || c.text }))
  );

  return {
    id: item.id,
    name: item.name_ex ? `${item.name_ex.primary}${item.name_ex.extension ? ', ' + item.name_ex.extension : ''}` : item.name,
    legal_name: item.name_ex?.legal_name || item.org?.name || '',
    address: item.address_name || '',
    city: item.adm_div?.find(d => d.type === 'city')?.name || '',
    district: item.adm_div?.find(d => d.type === 'district')?.name || '',
    point: item.point || null,
    rubrics: (item.rubrics || []).map(r => r.name),
    rating: item.reviews?.rating || null,
    review_count: item.reviews?.review_count || null,
    schedule: item.schedule || null,
    contacts,
    phones: contacts.filter(c => c.type === 'phone').map(c => c.value),
    website: contacts.find(c => c.type === 'website')?.value || '',
    whatsapp: contacts.find(c => c.type === 'whatsapp')?.value || '',
    telegram: contacts.find(c => c.type === 'telegram')?.value || '',
    email: contacts.filter(c => c.type === 'email').map(c => c.value),
  };
}

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const results = [];
  const errors = [];
  
  for (let i = 0; i < firmIds.length; i++) {
    const id = typeof firmIds[i] === 'object' ? firmIds[i].id : firmIds[i];
    console.log(`[${i+1}/${firmIds.length}] Fetching ${id}...`);
    
    try {
      const firm = await fetchFirm(id);
      if (firm.error) {
        console.warn(`  Error: ${firm.error}`);
        errors.push(firm);
      } else {
        console.log(`  OK: ${firm.name} | phones: ${firm.phones.join(', ')}`);
        results.push(firm);
      }
    } catch (e) {
      console.error(`  Failed: ${e.message}`);
      errors.push({ id, error: e.message });
    }
    
    if (i < firmIds.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\nDone! ${results.length} firms fetched, ${errors.length} errors`);
  
  const blob = new Blob([JSON.stringify({ results, errors }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '2gis-contacts.json';
  a.click();
  console.log('Download triggered: 2gis-contacts.json');
  
  // Also copy results to clipboard
  copy(results);
  console.log('Results array copied to clipboard');
})();
