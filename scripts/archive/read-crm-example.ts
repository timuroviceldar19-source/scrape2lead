import ExcelJS from 'exceljs';

const filePath = 'C:\\Users\\Madara\\Downloads\\kaspi_leads_example_clean_crm.xlsx';

async function readCrmExample() {
  try {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    
    console.log("=== ALL SHEETS ===");
    console.log(workbook.worksheets.map(w => w.name));
    
    for (const worksheet of workbook.worksheets) {
      console.log(`\n=== SHEET: ${worksheet.name} ===`);
      const rows: any[] = [];
      worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber <= 15) { // Limit output
          const rowData: any = {};
          row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
            const header = worksheet.getRow(1).getCell(colNumber).value?.toString() || `col${colNumber}`;
            rowData[header] = cell.value;
          });
          rows.push(rowData);
        }
      });
      console.log(JSON.stringify(rows, null, 2));
    }
  } catch (error) {
    console.error("Error reading Excel file:", error);
  }
}

readCrmExample();
