// === 2GIS Firm URL Collector ===
// Paste this into Chrome DevTools Console on a 2GIS search results page
// After scrolling through all results to load them

(function() {
  const links = document.querySelectorAll('a[href*="/firm/"]');
  const firms = new Map();
  
  links.forEach(a => {
    const match = a.href.match(/\/firm\/([0-9]+)/);
    if (match) {
      const id = match[1];
      const name = a.closest('[class*="card"]')?.querySelector('[class*="name"]')?.textContent?.trim() 
        || a.textContent?.trim() 
        || '';
      if (!firms.has(id)) {
        firms.set(id, { id, name, url: `https://2gis.kz/astana/firm/${id}` });
      }
    }
  });

  const result = [...firms.values()];
  console.log(`Found ${result.length} firms`);
  console.log(JSON.stringify(result, null, 2));
  
  // Copy to clipboard
  copy(result);
  console.log('Copied to clipboard! Paste into a .json file.');
  
  // Also create downloadable blob
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '2gis-firm-urls.json';
  a.click();
  console.log('Download triggered: 2gis-firm-urls.json');
})();
