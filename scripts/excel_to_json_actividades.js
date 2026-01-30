import xlsx from "xlsx";
import fs from "fs";

const input = process.argv[2];       // ruta excel
const sheetName = process.argv[3];   // nombre hoja (opcional)

if (!input) {
  console.error("Uso: node scripts/excel_to_json_actividades.js <Actividades_Labores.xlsx> [Hoja1]");
  process.exit(1);
}

const wb = xlsx.readFile(input);
const ws = wb.Sheets[sheetName || wb.SheetNames[0]];
const rows = xlsx.utils.sheet_to_json(ws, { defval: "" });

const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== "") return obj[k];
  }
  return "";
};

const payload = rows
  .map((r) => {
    const codigo = String(
      pick(r, ["CODIGO", "Codigo", "codigo", "COD", "cod"])
    ).trim();

    const nome = String(
      pick(r, ["NOME", "Nome", "nome", "NOMBRE", "Nombre"])
    ).trim();

    const nomMecan = String(
      pick(r, ["NOM_MECAN", "Nom_Mecan", "nom_mecan", "NOM MECAN", "Nom Mecan"])
    ).trim();

    const nomTipo = String(
      pick(r, ["NOM_TIPO", "Nom_Tipo", "nom_tipo", "NOM TIPO", "Nom Tipo"])
    ).trim();

    return {
      CODIGO: codigo,
      NOME: nome,
      NOM_MECAN: nomMecan,
      NOM_TIPO: nomTipo,
    };
  })
  .filter((x) => x.CODIGO); // solo filas con código

fs.writeFileSync("payload.actividades.json", JSON.stringify({ payload }, null, 2));
console.log("OK -> payload.actividades.json | filas:", payload.length);
