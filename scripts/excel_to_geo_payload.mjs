import fs from "fs";
import path from "path";
import xlsx from "xlsx";

const inputXlsx = process.argv[2]; // ej:ste.xlsx
if (!inputXlsx) {
  console.error("Uso: node scripts/excel_to_geo_payload.mjs <ruta_excel.xlsx> [sheetName] [chunkSize]");
  process.exit(1);
}

const sheetNameArg = process.argv[3] || null;
const chunkSize = Number(process.argv[4] || 0); // 0 = sin chunks

const wb = xlsx.readFile(inputXlsx);
const sheetName = sheetNameArg || wb.SheetNames[0];
const ws = wb.Sheets[sheetName];

const rows = xlsx.utils.sheet_to_json(ws, { defval: "" });

// Normaliza filas a lo que espera tu RPC (mantén claves exactas)
const payload = rows.map((r) => {
  // Area_ha viene con coma; lo dejamos como string y la función SQL lo convierte.
  // Si viene como número, lo convertimos a string.
  const area = r["Area_ha"];
  const areaStr = typeof area === "number" ? String(area) : String(area || "");

  return {
    NOM: String(r["NOM"] ?? ""),
    ORG: String(r["ORG"] ?? ""),
    RIES: String(r["RIES"] ?? ""),
    RIE: String(r["RIE"] ?? ""),
    Zona: String(r["Zona"] ?? ""),
    Mecanizada: String(r["Mecanizada"] ?? ""),
    Prep: String(r["Prep"] ?? ""),
    Lab_Cul: String(r["Lab_Cul"] ?? ""),
    Hac: String(r["Hac"] ?? ""),
    Ste: String(r["Ste"] ?? ""),
    Hac_Ste: String(r["Hac_Ste"] ?? ""),
    Ten: String(r["Ten"] ?? ""),
    Area_ha: areaStr,
    geometry_wkt: String(r["geometry_wkt"] ?? ""),
  };
});

// Salida
const outDir = path.join(process.cwd(), "out");
fs.mkdirSync(outDir, { recursive: true });

if (!chunkSize || chunkSize <= 0) {
  const outFile = path.join(outDir, "payload.geo_lotes.json");
  fs.writeFileSync(outFile, JSON.stringify({ payload }, null, 2), "utf-8");
  console.log(`OK -> ${outFile} (${payload.length} filas)`);
} else {
  let part = 1;
  for (let i = 0; i < payload.length; i += chunkSize) {
    const chunk = payload.slice(i, i + chunkSize);
    const outFile = path.join(outDir, `payload.geo_lotes.part${part}.json`);
    fs.writeFileSync(outFile, JSON.stringify({ payload: chunk }, null, 2), "utf-8");
    console.log(`OK -> ${outFile} (${chunk.length} filas)`);
    part++;
  }
}
